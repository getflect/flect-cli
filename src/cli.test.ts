import { describe, it, expect, afterEach } from "vitest"
import { parseFlectToml, FlectTomlError } from "./config.js"
import { resolveConnection, maskToken } from "./cli-config.js"
import { generateLocalConfig } from "./local.js"
import { redactConnection } from "./scaffold.js"
import { scopeIdFromToken } from "./broker-client.js"
import { deploy, deployApps, type DeployState, type DeployIO } from "./deploy.js"
import type { BrokerClient, ProviderRow } from "./broker-client.js"

const CLAVE_TOML = `
[app]
name   = "clave"
domain = "clave-api.up.flect.run"

[[apps]]
name   = "clave-api"
image  = "ghcr.io/dotlabshq/clave-api:0.1.36"
port   = 3000
public = true

[[apps]]
name   = "auth-service"
image  = "ghcr.io/dotlabshq/auth-service:0.1.11"
expose = "/v1/auth"

[vars]
OIDC_ISSUER = "https://nesskey.com"
JWT_SECRET  = "sekret"

[[databases]]
binding = "DB"
name    = "clave-db"

[[services]]
binding = "AUTH_SERVICE"
app     = "auth-service"
`

const TOML = `
name = "myapp"
runtime = "node"
port = 3000

[[databases]]
binding = "DB"
name = "myapp-db"
migrations_dir = "migrations"

[[kv]]
binding = "CACHE"
name = "myapp-cache"

[[stores]]
binding = "FILES"
name = "myapp-uploads"
`

describe("parseFlectToml", () => {
  it("parses and normalizes all binding kinds", () => {
    const p = parseFlectToml(TOML)
    expect(p.name).toBe("myapp")
    expect(p.port).toBe(3000)
    expect(p.bindings).toEqual([
      { name: "DB", kind: "database", resource: "myapp-db", migrationsDir: "migrations" },
      { name: "CACHE", kind: "kv", resource: "myapp-cache" },
      { name: "FILES", kind: "storage", resource: "myapp-uploads" },
    ])
  })

  it("requires a top-level name", () => {
    expect(() => parseFlectToml(`[[kv]]\nbinding="X"\nname="y"`)).toThrowError(FlectTomlError)
  })

  it("rejects a binding entry missing binding/name", () => {
    expect(() => parseFlectToml(`name="a"\n[[databases]]\nname="x"`)).toThrowError(/binding" is required/)
  })

  it("rejects duplicate binding names", () => {
    const dup = `name="a"\n[[kv]]\nbinding="C"\nname="c1"\n[[databases]]\nbinding="C"\nname="c2"`
    expect(() => parseFlectToml(dup)).toThrowError(/duplicate binding name/)
  })

  it("parses the app-group form ([app] + [[apps]] + [vars] + [[services]])", () => {
    const p = parseFlectToml(CLAVE_TOML)
    expect(p.name).toBe("clave")
    expect(p.domain).toBe("clave-api.up.flect.run")
    expect(p.apps).toEqual([
      { name: "clave-api", image: "ghcr.io/dotlabshq/clave-api:0.1.36", port: 3000, public: true, expose: undefined, replicas: undefined, cpuMhz: undefined, memoryMb: undefined },
      { name: "auth-service", image: "ghcr.io/dotlabshq/auth-service:0.1.11", port: undefined, public: undefined, expose: "/v1/auth", replicas: undefined, cpuMhz: undefined, memoryMb: undefined },
    ])
    expect(p.vars).toEqual({ OIDC_ISSUER: "https://nesskey.com", JWT_SECRET: "sekret" })
    expect(p.services).toEqual([{ binding: "AUTH_SERVICE", app: "auth-service" }])
    expect(p.bindings).toHaveLength(1)
  })

  it("rejects more than one public app", () => {
    const two = `[app]\nname="x"\n[[apps]]\nname="a"\npublic=true\n[[apps]]\nname="b"\npublic=true`
    expect(() => parseFlectToml(two)).toThrowError(/only one app may be public/)
  })

  it("parses scope and region", () => {
    const p = parseFlectToml(`name="a"\nscope="acme/notes/prod"\nregion="eu"`)
    expect(p.scope).toBe("acme/notes/prod")
    expect(p.region).toBe("eu")
  })

  it("rejects a scope path with more than 3 segments", () => {
    expect(() => parseFlectToml(`name="a"\nscope="a/b/c/d"`)).toThrowError(/1–3 segment/)
  })

  it("rejects unknown regions (only eu exists today)", () => {
    expect(() => parseFlectToml(`name="a"\nregion="us"`)).toThrowError(/only "eu"/)
  })
})

describe("ensureScopePath — deploy realizes the toml scope", () => {
  function fakeScopeClient(
    existing: Array<{ id: string; parentId: string | null; slug: string; name: string; kind: string }>,
  ) {
    const rows = [...existing]
    const created: Array<{ kind: string; slug: string; parentId?: string }> = []
    return {
      created,
      listScopes: async () => rows as never,
      createScope: async (input: { kind: string; name: string; slug: string; parentId?: string }) => {
        const row = {
          id: `scope-${input.slug}`,
          parentId: input.parentId ?? null,
          slug: input.slug,
          name: input.name,
          kind: input.kind,
        }
        rows.push(row)
        created.push({ kind: input.kind, slug: input.slug, parentId: input.parentId })
        return row as never
      },
    }
  }

  it("creates every missing segment with the right kind and parent", async () => {
    const client = fakeScopeClient([])
    const { ensureScopePath } = await import("./scope-path.js")
    const r = await ensureScopePath(client, "acme/notes/prod")
    expect(r.scopeId).toBe("scope-prod")
    expect(client.created).toEqual([
      { kind: "workspace", slug: "acme", parentId: undefined },
      { kind: "project", slug: "notes", parentId: "scope-acme" },
      { kind: "environment", slug: "prod", parentId: "scope-notes" },
    ])
    expect(r.created).toHaveLength(3)
  })

  it("reuses existing segments and only creates the missing tail", async () => {
    const client = fakeScopeClient([
      { id: "ws-1", parentId: null, slug: "acme", name: "acme", kind: "workspace" },
      { id: "pr-1", parentId: "ws-1", slug: "notes", name: "notes", kind: "project" },
    ])
    const { ensureScopePath } = await import("./scope-path.js")
    const r = await ensureScopePath(client, "acme/notes/prod")
    expect(r.scopeId).toBe("scope-prod")
    expect(client.created).toEqual([{ kind: "environment", slug: "prod", parentId: "pr-1" }])
  })

  it("is idempotent when the whole path exists", async () => {
    const client = fakeScopeClient([
      { id: "ws-1", parentId: null, slug: "acme", name: "acme", kind: "workspace" },
      { id: "pr-1", parentId: "ws-1", slug: "notes", name: "notes", kind: "project" },
      { id: "env-1", parentId: "pr-1", slug: "prod", name: "prod", kind: "environment" },
    ])
    const { ensureScopePath } = await import("./scope-path.js")
    const r = await ensureScopePath(client, "acme/notes/prod")
    expect(r.scopeId).toBe("env-1")
    expect(r.created).toHaveLength(0)
    expect(client.created).toHaveLength(0)
  })

  it("rejects paths deeper than the tree", async () => {
    const { ensureScopePath } = await import("./scope-path.js")
    await expect(ensureScopePath(fakeScopeClient([]), "a/b/c/d")).rejects.toThrowError(/1–3 segments/)
  })
})

describe("generateLocalConfig", () => {
  it("maps bindings to ${ENV}-driven connections, never literal secrets", () => {
    const config = generateLocalConfig(parseFlectToml(TOML))
    expect(config.bindings.DB).toEqual({
      kind: "database",
      provider: "libsql",
      connection: { url: "${DB_URL:-:memory:}" },
    })
    expect(config.bindings.CACHE!.connection).toEqual({
      url: "${VALKEY_URL:-redis://localhost:6379}",
      keyPrefix: "myapp-myapp-cache:",
    })
    const files = config.bindings.FILES!.connection
    expect(files.accessKeyId).toBe("${S3_ACCESS_KEY_ID}")
    expect(files.secretAccessKey).toBe("${S3_SECRET_ACCESS_KEY}")
    // Every secret-bearing value is an ${ENV} placeholder, not a literal.
    for (const v of Object.values(files)) {
      if (typeof v === "string" && /token|secret|key/i.test(v)) expect(v).toMatch(/^\$\{[^}]+\}$/)
    }
  })
})

describe("resolveConnection", () => {
  const saved = { url: process.env["FLECT_BROKER_URL"], tok: process.env["FLECT_TOKEN"] }
  afterEach(() => {
    if (saved.url === undefined) delete process.env["FLECT_BROKER_URL"]
    else process.env["FLECT_BROKER_URL"] = saved.url
    if (saved.tok === undefined) delete process.env["FLECT_TOKEN"]
    else process.env["FLECT_TOKEN"] = saved.tok
  })

  it("flag beats env", async () => {
    process.env["FLECT_BROKER_URL"] = "http://from-env"
    process.env["FLECT_TOKEN"] = "env-tok"
    const c = await resolveConnection({ broker: "http://from-flag", token: "flag-tok" })
    expect(c).toEqual({ brokerUrl: "http://from-flag", token: "flag-tok" })
  })

  it("env is used when no flag is given", async () => {
    process.env["FLECT_BROKER_URL"] = "http://env-broker"
    process.env["FLECT_TOKEN"] = "env-tok"
    const c = await resolveConnection({})
    expect(c).toEqual({ brokerUrl: "http://env-broker", token: "env-tok" })
  })
})

describe("maskToken", () => {
  it("shows dev tokens (not yet secrets) and masks opaque ones", () => {
    expect(maskToken("dev:acme:scope-1")).toBe("dev:acme:scope-1")
    expect(maskToken(undefined)).toBe("(unset)")
    expect(maskToken("supersecrettoken")).toMatch(/^supe….+/)
  })
})

describe("scope paths", () => {
  const scopes = [
    { id: "s-ws", kind: "workspace" as const, parentId: null, name: "saas", slug: "saas", status: "active" },
    { id: "s-proj", kind: "project" as const, parentId: "s-ws", name: "scanopy", slug: "scanopy", status: "active" },
    { id: "s-dev", kind: "environment" as const, parentId: "s-proj", name: "dev", slug: "dev", status: "active" },
    { id: "s-prod", kind: "environment" as const, parentId: "s-proj", name: "prod", slug: "prod", status: "active" },
  ]

  it("resolves a slug path to a scope id", async () => {
    const { resolveScopePath, scopePathOf } = await import("./scope-path.js")
    expect(resolveScopePath(scopes, "saas/scanopy/dev")).toBe("s-dev")
    expect(resolveScopePath(scopes, "saas")).toBe("s-ws")
    expect(scopePathOf(scopes, "s-prod")).toBe("saas/scanopy/prod")
    expect(scopePathOf(scopes, "unknown")).toBe("unknown")
  })

  it("throws a helpful error for a missing segment", async () => {
    const { resolveScopePath } = await import("./scope-path.js")
    expect(() => resolveScopePath(scopes, "saas/nope/dev")).toThrowError(/scope "nope" not found/)
  })
})

describe("scopeIdFromToken", () => {
  it("extracts the scope from a dev token", () => {
    expect(scopeIdFromToken("dev:acme:scope-demo")).toBe("scope-demo")
  })
  it("throws on an unsupported token", () => {
    expect(() => scopeIdFromToken("opaque-jwt")).toThrowError()
  })
})

describe("redactConnection", () => {
  it("masks secret fields, keeps benign ones like keyPrefix", () => {
    expect(
      redactConnection({ url: "redis://x", keyPrefix: "app:", authToken: "sekret", accessKeyId: "GK", secretAccessKey: "s" }),
    ).toEqual({
      url: "redis://x",
      keyPrefix: "app:",
      authToken: "***redacted***",
      accessKeyId: "***redacted***",
      secretAccessKey: "***redacted***",
    })
  })
})

describe("deploy", () => {
  const project = parseFlectToml(`name="myapp"\n[[databases]]\nbinding="DB"\nname="myapp-db"\n[[kv]]\nbinding="CACHE"\nname="myapp-cache"`)

  function fakeClient(overrides: Partial<BrokerClient> = {}): BrokerClient {
    let n = 0
    const base: Partial<BrokerClient> = {
      listProviders: async (): Promise<ProviderRow[]> => [
        { id: "provider-db", kind: "sqld", bindingKind: "database", region: "eu", endpoint: "http://db", status: "active" },
        { id: "provider-kv", kind: "valkey", bindingKind: "kv", region: "eu", endpoint: "http://kv", status: "active" },
      ],
      requestResource: async () => ({ id: `resource-${++n}` }),
      runProvisioner: async () => ({ provisioned: [`resource-${n}`], failed: [], deprovisioned: [] }),
      declareBinding: async () => ({ id: `binding-${n}`, status: "declared" }),
      bind: async () => ({ status: "bound" }),
    }
    return { ...base, ...overrides } as BrokerClient
  }

  function memoryIO(initial: DeployState = { bindings: {} }): DeployIO & { state: DeployState } {
    const holder = { state: initial }
    return {
      state: holder.state,
      loadState: async () => holder.state,
      saveState: async (s) => {
        holder.state = s
      },
    }
  }

  it("provisions and binds every declared binding", async () => {
    const io = memoryIO()
    const steps = await deploy(fakeClient(), project, "scope-demo", io)
    expect(steps.map((s) => s.status)).toEqual(["bound", "bound"])
    expect(Object.keys(io.state.bindings)).toEqual(["DB", "CACHE"])
  })

  it("is idempotent — already-bound bindings are skipped", async () => {
    const io = memoryIO({ bindings: { DB: { resourceId: "resource-x", bindingId: "binding-x" } } })
    const steps = await deploy(fakeClient(), project, "scope-demo", io)
    expect(steps.find((s) => s.binding === "DB")!.status).toBe("already-bound")
    expect(steps.find((s) => s.binding === "CACHE")!.status).toBe("bound")
  })

  it("fails a binding whose kind has no active provider", async () => {
    const client = fakeClient({ listProviders: async () => [] })
    const steps = await deploy(client, project, "scope-demo", memoryIO())
    expect(steps.every((s) => s.status === "failed")).toBe(true)
    expect(steps[0]!.detail).toMatch(/no active provider/)
  })

  it("reports a provisioning failure without binding", async () => {
    const client = fakeClient({
      requestResource: async () => ({ id: "resource-boom" }),
      runProvisioner: async () => ({ provisioned: [], failed: ["resource-boom"], deprovisioned: [] }),
    })
    const steps = await deploy(client, project, "scope-demo", memoryIO())
    expect(steps[0]!.status).toBe("failed")
    expect(steps[0]!.detail).toMatch(/provisioning failed/)
  })
})

describe("deployApps", () => {
  it("declares and deploys each app, passing vars + services", async () => {
    const project = parseFlectToml(CLAVE_TOML)
    const declared: unknown[] = []
    const deployed: Array<{ id: string; input: unknown }> = []
    const client = {
      declareApp: async (input: { name: string }) => {
        declared.push(input)
        return { id: `app-${input.name}`, name: input.name, status: "declared" }
      },
      deployApp: async (id: string, input: unknown) => {
        deployed.push({ id, input })
        return { status: "deployed", jobId: `flect-${id}`, hostname: id.includes("api") ? "clave-api.up.flect.run" : null, failureReason: null }
      },
    } as unknown as BrokerClient

    const steps = await deployApps(client, project)
    expect(steps.map((s) => s.status)).toEqual(["deployed", "deployed"])
    expect(steps[0]!.hostname).toBe("clave-api.up.flect.run")
    // vars + services forwarded to each deploy
    expect(deployed[0]!.input).toMatchObject({
      vars: { OIDC_ISSUER: "https://nesskey.com", JWT_SECRET: "sekret" },
      services: [{ binding: "AUTH_SERVICE", app: "auth-service" }],
    })
    // domain passed to declare so routing lines up
    expect(declared[0]).toMatchObject({ name: "clave-api", public: true, domain: "clave-api.up.flect.run" })
  })

  it("declares EVERY app before deploying any (so a consumer listed first still resolves its provider)", async () => {
    // ownwares (consumer) is listed BEFORE eventstore-service (its provider).
    const project = parseFlectToml(
      `[app]\nname="s"\n` +
        `[[apps]]\nname="ownwares"\nimage="img:1"\npublic=true\n` +
        `[[apps]]\nname="eventstore-service"\nimage="img:2"\n` +
        `[[services]]\nbinding="EVENTSTORE"\napp="eventstore-service"`,
    )
    const calls: string[] = []
    const client = {
      declareApp: async (input: { name: string }) => {
        calls.push(`declare:${input.name}`)
        return { id: `app-${input.name}`, name: input.name, status: "declared" }
      },
      deployApp: async (id: string) => {
        calls.push(`deploy:${id}`)
        return { status: "deployed", jobId: `flect-${id}`, hostname: null, failureReason: null }
      },
    } as unknown as BrokerClient

    await deployApps(client, project)

    const firstDeploy = calls.findIndex((c) => c.startsWith("deploy:"))
    const lastDeclare = calls.map((c) => c.startsWith("declare:")).lastIndexOf(true)
    // every declare precedes every deploy → provider is known when consumer deploys
    expect(lastDeclare).toBeLessThan(firstDeploy)
    expect(calls.filter((c) => c.startsWith("declare:"))).toEqual(["declare:ownwares", "declare:eventstore-service"])
  })

  it("marks an app failed when the broker reports a deploy failure", async () => {
    const project = parseFlectToml(`[app]\nname="x"\n[[apps]]\nname="api"\nimage="img:1"\npublic=true`)
    const client = {
      declareApp: async () => ({ id: "app-api", name: "api", status: "declared" }),
      deployApp: async () => ({ status: "failed", jobId: null, hostname: null, failureReason: "no image to deploy" }),
    } as unknown as BrokerClient
    const steps = await deployApps(client, project)
    expect(steps[0]).toMatchObject({ app: "api", status: "failed", detail: "no image to deploy" })
  })
})
