import { describe, expect, it } from "vitest"
import { parseAppFile } from "./app-file.js"
import { parseFlectToml } from "./config.js"
import { applyAppDeploy, planAppDeploy } from "./deploy-app.js"
import { BrokerError, type AppRow, type BindingRow, type ResourceRow } from "./broker-client.js"

const CLAVE = `
[app]
name  = "clave"
scope = "platform/clave/production"

[[databases]]
binding = "DB"
id      = "res_k7f3a2"

[vars]
NODE_ENV = "production"

[services.foldbase]
name  = "foldbase"
image = "ghcr.io/dotlabshq/foldbase:0.5.0"
port  = 3001
uses  = ["DB"]

[services.foldbase.vars]
DB_URL = "flect://DB"

[services.api]
image = "ghcr.io/dotlabshq/clave-api:0.2.4"
calls = ["foldbase"]

[services.web]
image  = "ghcr.io/dotlabshq/clave-web:0.2.4"
public = true
calls  = ["api"]
`

describe("parseAppFile", () => {
  it("reads one application in one scope", () => {
    const f = parseAppFile(CLAVE)
    expect(f.scope).toBe("platform/clave/production")
    expect(f.resources).toEqual([{ binding: "DB", kind: "database", id: "res_k7f3a2" }])
    expect(f.services.map((s) => [s.key, s.name])).toEqual([["foldbase", "foldbase"], ["api", "clave-api"], ["web", "clave-web"]])
    const fb = f.services[0]!
    expect(fb.uses).toEqual(["DB"])
    // [vars] for every service, the service's own on top.
    expect(fb.vars).toEqual({ NODE_ENV: "production", DB_URL: "flect://DB" })
    expect(f.services[1]!.vars).toEqual({ NODE_ENV: "production" })
    expect(f.services[1]!.uses).toEqual([])
  })

  const bad = (patch: (t: string) => string) => () => parseAppFile(patch(CLAVE))

  it("requires a scope", () => {
    expect(bad((t) => t.replace(`scope = "platform/clave/production"\n`, ""))).toThrow(/\[app\]\.scope is required/)
  })

  it("stops on a uses or calls that names nothing, with a hint", () => {
    expect(bad((t) => t.replace(`uses  = ["DB"]`, `uses  = ["DBB"]`))).toThrow(/no resource has binding = "DBB"; did you mean "DB"/)
    expect(bad((t) => t.replace(`calls = ["foldbase"]`, `calls = ["foldbse"]`))).toThrow(/no \[services.foldbse\]; did you mean "foldbase"/)
    expect(bad((t) => t.replace(`calls  = ["api"]`, `calls  = ["web"]`))).toThrow(/calls itself/)
  })

  it("stops on a resource without an id, or created by name, or with an id per environment", () => {
    expect(bad((t) => t.replace(`id      = "res_k7f3a2"`, ""))).toThrow(/has no id: create one with `flect db create clave-db -c flect.toml`/)
    expect(bad((t) => t.replace(`id      = "res_k7f3a2"`, `name = "clave-db"`))).toThrow(/used by id/)
    expect(bad((t) => t.replace(`id      = "res_k7f3a2"`, `id.production = "res_k7f3a2"`))).toThrow(/another environment is another file/)
  })

  it("cannot be mixed with [[apps]], and a secret is not also a var", () => {
    expect(bad((t) => t + `\n[[apps]]\nname = "x"\n`)).toThrow(/cannot be mixed/)
    expect(bad((t) => t.replace(`calls = ["foldbase"]`, `calls = ["foldbase"]\nsecrets = ["NODE_ENV"]`))).toThrow(/both a var and a secret/)
  })

  it("the old parser refuses it instead of reading it wrong", () => {
    expect(() => parseFlectToml(CLAVE)).toThrow(/services format/)
  })
})

/** A broker with one database in the scope and whatever the test adds. */
function fakeBroker(o: { bindings?: BindingRow[]; apps?: AppRow[]; kept?: Record<string, string[]>; resources?: ResourceRow[] } = {}) {
  const db: ResourceRow = {
    id: "resource-1", kind: "database", scopeId: "s1", providerId: "p", name: "clave-db",
    externalRef: "ns", status: "provisioned", failureReason: null, shortId: "k7f3a2",
  }
  const resources = o.resources ?? [db]
  const calls: Array<[string, unknown]> = []
  let n = 0
  const client = {
    calls,
    async getResource(ref: string) {
      const r = resources.find((x) => `res_${x.shortId}` === ref || x.id === ref)
      if (!r) throw new BrokerError(404, "NOT_FOUND", "not found")
      return r
    },
    async listResources() { return resources },
    async listBindings() { return o.bindings ?? [] },
    async listApps() { return o.apps ?? [] },
    async keptVarNames(id: string) { return { names: o.kept?.[id] ?? [] } },
    async declareBinding(i: unknown) { calls.push(["declareBinding", i]); return { id: "binding-new", status: "declared" } },
    async bind(id: string, resourceId: string) { calls.push(["bind", { id, resourceId }]); return { status: "bound" } },
    async declareApp(i: { name: string }) { calls.push(["declareApp", i.name]); return { id: `app-${++n}`, name: i.name, status: "declared" } },
    async deployApp(id: string, i: unknown) {
      calls.push(["deployApp", { id, ...(i as object) }])
      return { status: "deployed", jobId: "j", hostname: null, failureReason: null }
    },
  }
  return client
}
const scope = { id: "s1", label: "dotlabs/platform/clave/production" }

describe("flect deploy (services format)", () => {
  it("binds the resource by id and deploys each service with only its own uses, calls and vars", async () => {
    const f = parseAppFile(CLAVE)
    const client = fakeBroker()
    const plan = await planAppDeploy(client, f, scope)
    expect(plan.stops).toEqual([])
    const out = await applyAppDeploy(client, f, plan, "s1")
    expect(out.binds.every((b) => b.ok)).toBe(true)
    expect(client.calls.filter(([k]) => k === "bind")).toEqual([["bind", { id: "binding-new", resourceId: "resource-1" }]])

    const deploys = client.calls.filter(([k]) => k === "deployApp").map(([, v]) => v as { uses: string[]; services: unknown[]; vars: object })
    // Declared all three before deploying any.
    expect(client.calls.slice(2, 5).map(([k]) => k)).toEqual(["declareApp", "declareApp", "declareApp"])
    expect(deploys.map((d) => d.uses)).toEqual([["DB"], [], []])
    expect(deploys[1]!.services).toEqual([{ binding: "foldbase", app: "foldbase" }])
    expect(deploys[2]!.services).toEqual([{ binding: "api", app: "clave-api" }])
    expect(deploys[1]!.vars).toEqual({ NODE_ENV: "production" })
  })

  it("an existing binding of this resource is kept; one pointing elsewhere stops the deploy", async () => {
    const f = parseAppFile(CLAVE)
    const mine: BindingRow = { bindingId: "b1", bindingName: "DB", kind: "database", scopeId: "s1", resourceId: "resource-1", resolvable: true }
    expect((await planAppDeploy(fakeBroker({ bindings: [mine] }), f, scope)).binds[0]!.action).toBe("keep")

    const other = { ...mine, resourceId: "resource-2" }
    const res2: ResourceRow = { ...(await fakeBroker().getResource("resource-1")), id: "resource-2", shortId: "zzzzzz" }
    const plan = await planAppDeploy(fakeBroker({ bindings: [other], resources: [await fakeBroker().getResource("resource-1"), res2] }), f, scope)
    expect(plan.stops.join()).toMatch(/already has a binding "DB" pointing at res_zzzzzz/)
  })

  it("an id that is not a resource of the scope stops it, before anything changes", async () => {
    const f = parseAppFile(CLAVE.replace("res_k7f3a2", "res_p91xq4"))
    const client = fakeBroker()
    const plan = await planAppDeploy(client, f, scope)
    expect(plan.stops).toEqual(["DB: res_p91xq4 is not a database in dotlabs/platform/clave/production"])
    expect(client.calls).toEqual([])
  })

  it("stops when kept vars would be dropped, unless --yes", async () => {
    const f = parseAppFile(CLAVE)
    const apps: AppRow[] = [{ id: "app-api", name: "clave-api", status: "deployed", image: null, public: false, expose: null, domain: null, hostname: null, jobId: null }]
    const kept = { "app-api": ["JWT_SECRET", "NODE_ENV"] }
    const stopped = await planAppDeploy(fakeBroker({ apps, kept }), f, scope)
    expect(stopped.stops).toEqual(["api: the last deploy kept JWT_SECRET, which flect.toml no longer has; add them to vars or secrets, or pass --yes to drop them"])
    const yes = await planAppDeploy(fakeBroker({ apps, kept }), f, scope, { yes: true })
    expect(yes.stops).toEqual([])
    expect(yes.warnings.join()).toMatch(/dropping \(--yes\)/)
  })

  it("warns about an unused resource, a secret-looking var, and a service no longer in the file", async () => {
    const f = parseAppFile(CLAVE.replace(`uses  = ["DB"]`, "").replace(`NODE_ENV = "production"`, `NODE_ENV = "production"\nAPI_TOKEN = "x"`))
    const apps: AppRow[] = [{ id: "app-old", name: "clave-org", status: "deployed", image: null, public: false, expose: null, domain: null, hostname: null, jobId: null }]
    const plan = await planAppDeploy(fakeBroker({ apps }), f, scope)
    expect(plan.warnings).toEqual([
      "DB is not in any service's uses",
      "API_TOKEN looks like a secret; it belongs in secrets, not vars",
      "clave-org runs in dotlabs/platform/clave/production but is not in flect.toml; it keeps running until it is deleted",
    ])
  })

  it("secrets stop the deploy until P3", async () => {
    const f = parseAppFile(CLAVE.replace(`calls = ["foldbase"]`, `calls = ["foldbase"]\nsecrets = ["JWT_SECRET"]`))
    expect((await planAppDeploy(fakeBroker(), f, scope)).stops.join()).toMatch(/secrets are not supported/)
  })
})
