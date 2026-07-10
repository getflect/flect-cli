#!/usr/bin/env node
/**
 * Flect CLI (RFC-0010) — a thin client over the control plane, plus local dev.
 *
 *   flect init                 scaffold flect.toml
 *   flect dev                  generate flect.local.json so createEnv() runs locally
 *   flect bindings             list bindings declared in flect.toml
 *   flect db|kv|store create   create a resource (also: list, status, delete)
 *   flect deploy               realize flect.toml against the broker (provision + bind + apps)
 *   flect resolve DB           inspect a binding's manifest (secrets redacted)
 *   flect config set broker …  persist API base / token in ~/.flect/config.json
 */

import { writeFile, readFile, mkdir, access, appendFile } from "node:fs/promises"
import { basename } from "node:path"
import { spawn } from "node:child_process"
import { Command } from "commander"
import { loadFlectToml } from "./config.js"
import { generateLocalConfig } from "./local.js"
import { BrokerClient, scopeIdFromToken, withTokenScope, tokenInfo, type BindingKind } from "./broker-client.js"
import { ensureScopePath, resolveScopePath, scopePathOf } from "./scope-path.js"
import { createResource } from "./resource.js"
import { deploy, deployApps, type DeployState } from "./deploy.js"
import { flectTomlTemplate, GITIGNORE_LINES, redactConnection } from "./scaffold.js"
import {
  loadCliConfig,
  saveCliConfig,
  resolveConnection,
  maskToken,
  CONFIG_PATH,
  type CliConfig,
} from "./cli-config.js"

const exists = (p: string) => access(p).then(() => true).catch(() => false)

/** Open a URL in the default browser (best-effort, cross-platform). */
function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
  } catch {
    /* user can click the printed URL */
  }
}
const die = (msg: string): never => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** Resolve broker+token (flag > env > ~/.flect/config.json > default); token required. */
async function brokerConfig(opts: { broker?: string; token?: string }) {
  const { brokerUrl, token } = await resolveConnection(opts)
  if (!token) {
    die("no token — run `flect config set token <dev:tenant:scopeId>`, set FLECT_TOKEN, or pass --token")
  }
  return { brokerUrl, token: token! }
}

const program = new Command()
program
  .name("flect")
  .description("Flect platform CLI — deploy apps and resolve bindings through the control plane")
  .version("0.1.1")

program
  .command("init")
  .description("scaffold flect.toml in the current directory")
  .option("-n, --name <name>", "project name (default: directory name)")
  .action(async (opts: { name?: string }) => {
    if (await exists("flect.toml")) die("flect.toml already exists")
    const name = opts.name ?? basename(process.cwd())
    await writeFile("flect.toml", flectTomlTemplate(name))
    if (await exists(".gitignore")) await appendFile(".gitignore", GITIGNORE_LINES.join("\n"))
    else await writeFile(".gitignore", GITIGNORE_LINES.join("\n"))
    console.log(`✓ created flect.toml for "${name}"`)
    console.log("  next: `flect dev` for local development, or `flect deploy` to provision")
  })

program
  .command("dev")
  .description("generate flect.local.json from flect.toml (createEnv() runs locally, no broker)")
  .action(async () => {
    const project = await loadFlectToml().catch((e) => die(e.message))
    const config = generateLocalConfig(project)
    await writeFile("flect.local.json", JSON.stringify(config, null, 2) + "\n")
    console.log(`✓ wrote flect.local.json (${project.bindings.length} bindings)`)
    for (const b of project.bindings) console.log(`  ${b.name.padEnd(12)} ${b.kind}`)
    console.log("  secrets are read from ${ENV} at runtime — none are written here")
    console.log("  run your app: it only needs `createEnv()`")
  })

program
  .command("bindings")
  .description("list bindings declared in flect.toml")
  .action(async () => {
    const project = await loadFlectToml().catch((e) => die(e.message))
    console.log(`${project.name} — ${project.bindings.length} bindings, ${project.apps.length} apps`)
    for (const b of project.bindings) {
      console.log(`  binding  ${b.name.padEnd(14)} ${b.kind.padEnd(9)} → ${b.resource}`)
    }
    for (const a of project.apps) {
      const route = a.public ? "public" : a.expose ? `expose ${a.expose}` : "private"
      console.log(`  app      ${a.name.padEnd(14)} ${route}${a.image ? ` (${a.image})` : ""}`)
    }
    for (const s of project.services) {
      console.log(`  service  ${s.binding.padEnd(14)} → ${s.app}`)
    }
  })

program
  .command("deploy")
  .description("realize flect.toml against the broker (provision resources + bind)")
  .option("--broker <url>", "broker URL (default: FLECT_BROKER_URL)")
  .option("--token <token>", "runtime token (default: FLECT_TOKEN)")
  .option("--scope <scopeId|path>", "target scope (default: flect.toml scope, then the active scope)")
  .action(async (opts: { broker?: string; token?: string; scope?: string }) => {
    const project = await loadFlectToml().catch((e) => die(e.message))
    const cfg = await brokerConfig(opts)
    // Scope precedence: --scope flag > flect.toml `scope` > config's active
    // scope > dev-token segment. A slug PATH (flag containing "/", or the toml
    // value) resolves against the scope tree and CREATES any missing segment —
    // the manifest says where the project lives; deploy makes it true.
    const active = (await loadCliConfig()).scope
    let scopeId: string
    const pathSource = opts.scope && opts.scope.includes("/") ? opts.scope : !opts.scope ? project.scope : undefined
    if (pathSource) {
      const ensured = await ensureScopePath(new BrokerClient(cfg), pathSource).catch((e) =>
        die(e instanceof Error ? e.message : String(e)),
      )
      scopeId = ensured.scopeId
      const madeNew = ensured.created.length > 0 ? ` (created ${ensured.created.join(" → ")})` : ""
      console.log(`scope: ${pathSource}${madeNew}`)
    } else {
      scopeId = opts.scope ?? active ?? scopeIdFromToken(cfg.token)
    }
    if (project.region) console.log(`region: ${project.region}`)
    // The client must carry the scope so app deploys (which read X-Flect-Scope)
    // land in the same scope as the provisioned bindings.
    const client = new BrokerClient({ ...cfg, scope: scopeId })

    const steps = await deploy(client, project, scopeId, {
      loadState: async () => {
        if (!(await exists(".flect/state.json"))) return { bindings: {} }
        return JSON.parse(await readFile(".flect/state.json", "utf8")) as DeployState
      },
      saveState: async (state) => {
        await mkdir(".flect", { recursive: true })
        await writeFile(".flect/state.json", JSON.stringify(state, null, 2) + "\n")
      },
    })

    let failed = false
    if (project.bindings.length > 0) console.log("bindings:")
    for (const s of steps) {
      const mark = s.status === "failed" ? "✗" : "✓"
      console.log(`  ${mark} ${s.binding.padEnd(12)} ${s.status}${s.detail ? ` — ${s.detail}` : ""}`)
      if (s.status === "failed") failed = true
    }

    if (project.apps.length > 0) {
      console.log("apps:")
      const appSteps = await deployApps(client, project)
      for (const s of appSteps) {
        const mark = s.status === "failed" ? "✗" : "✓"
        const where = s.hostname ? ` → https://${s.hostname}` : ""
        console.log(`  ${mark} ${s.app.padEnd(16)} ${s.status}${where}${s.detail ? ` — ${s.detail}` : ""}`)
        if (s.status === "failed") failed = true
      }
    }

    if (failed) process.exit(1)
    console.log("deploy complete — apps resolve their bindings with createEnv()")
  })

/** Add the shared connection flags to a command. */
function withConn(cmd: Command): Command {
  return cmd
    .option("--broker <url>", "broker URL (default: config/env)")
    .option("--token <token>", "runtime token (default: config/env)")
    .option("--scope <scopeId>", "target scope (default: derived from token)")
}

type ConnOpts = { broker?: string; token?: string; scope?: string }
async function connect(opts: ConnOpts): Promise<{ client: BrokerClient; scopeId: string }> {
  const cfg = await brokerConfig(opts)
  const file = await loadCliConfig()
  // Active scope: flag > config.scope > dev-token segment (best effort).
  let scopeId = opts.scope ?? file.scope
  if (!scopeId) {
    try {
      scopeId = scopeIdFromToken(cfg.token)
    } catch {
      scopeId = ""
    }
  }
  return { client: new BrokerClient({ ...cfg, scope: scopeId || undefined }), scopeId }
}

/** Register a `flect <alias>` group with create/list/status/delete for a binding kind. */
function addResourceCommands(alias: string, kind: BindingKind, label: string): void {
  const group = program.command(alias).description(`manage ${label} resources`)

  withConn(group.command("create <name>"))
    .description(`create a ${label} resource`)
    .action(async (name: string, opts: ConnOpts) => {
      const { client, scopeId } = await connect(opts)
      try {
        const r = await createResource(client, scopeId, kind, name)
        console.log(`✓ created ${label} "${r.externalRef}" (${r.status})`)
        console.log(`  flect.toml → name = "${r.externalRef}"`)
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })

  withConn(group.command("list"))
    .description(`list ${label} resources in the scope`)
    .action(async (opts: ConnOpts) => {
      const { client, scopeId } = await connect(opts)
      const rows = await client.listResources(kind).catch((e) => die(e.message))
      console.log(`scope: ${scopeId}`)
      if (rows.length === 0) return void console.log(`  (no ${label} resources)`)
      for (const r of rows) {
        console.log(`  ${(r.externalRef ?? r.name).padEnd(24)} ${r.status.padEnd(14)} ${r.id}`)
      }
    })

  withConn(group.command("status <ref>"))
    .description(`show a ${label} resource's status`)
    .action(async (ref: string, opts: ConnOpts) => {
      const { client } = await connect(opts)
      try {
        const r = await client.getResource(ref)
        console.log(JSON.stringify(r, null, 2))
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })

  withConn(group.command("delete <ref>"))
    .description(`deprovision a ${label} resource`)
    .action(async (ref: string, opts: ConnOpts) => {
      const { client } = await connect(opts)
      try {
        const r = await client.deprovisionResource(ref)
        console.log(`✓ ${label} "${ref}" → ${r.status}`)
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })
}

addResourceCommands("db", "database", "database")
addResourceCommands("kv", "kv", "kv")
addResourceCommands("store", "storage", "storage")

// --- Scopes: the org's workspace/project/environment tree -------------------

const scope = program.command("scope").description("manage scopes (workspace / project / environment)")

withConn(scope.command("create <kind> <name>"))
  .description("create a scope; kind = workspace | project | environment")
  .option("--parent <scopeId>", "parent scope (e.g. project under a workspace)")
  .option("--slug <slug>", "slug (default: name)")
  .action(async (kind: string, name: string, opts: ConnOpts & { parent?: string; slug?: string }) => {
    if (!["workspace", "project", "environment"].includes(kind)) {
      die(`kind must be workspace | project | environment (got "${kind}")`)
    }
    const { client } = await connect(opts)
    try {
      const s = await client.createScope({
        kind: kind as "workspace" | "project" | "environment",
        name,
        slug: opts.slug ?? name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        parentId: opts.parent,
      })
      console.log(`✓ ${s.kind} "${s.name}" → ${s.id}`)
      console.log(`  activate it: flect use ${s.id}`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

withConn(scope.command("list"))
  .description("list the scope tree (active scope marked)")
  .action(async (opts: ConnOpts) => {
    const { client, scopeId } = await connect(opts)
    const rows = await client.listScopes().catch((e) => die(e.message))
    if (rows.length === 0) return void console.log("(no scopes — create one: flect scope create project myapp)")
    // Render as a tree: roots first, children indented under their parent.
    const byParent = new Map<string | null, typeof rows>()
    for (const s of rows) {
      const list = byParent.get(s.parentId) ?? []
      list.push(s)
      byParent.set(s.parentId, list)
    }
    const render = (parentId: string | null, depth: number) => {
      for (const s of byParent.get(parentId) ?? []) {
        const active = s.id === scopeId ? "  ← active" : ""
        console.log(`${"  ".repeat(depth)}${s.kind.padEnd(12)} ${s.name.padEnd(16)} ${s.id}${active}`)
        render(s.id, depth + 1)
      }
    }
    render(null, 0)
  })

withConn(program.command("use <scope>"))
  .description("switch the active scope — by slug path (saas/scanopy/dev) or scope id")
  .action(async (ref: string, opts: ConnOpts) => {
    const cfg = await loadCliConfig()
    if (!cfg.token) die("no token in config — run `flect login` or `flect config set token …` first")
    try {
      let scopeId = ref
      let path = ref
      if (!ref.startsWith("scope-")) {
        const { client } = await connect(opts)
        const scopes = await client.listScopes()
        scopeId = resolveScopePath(scopes, ref)
        path = scopePathOf(scopes, scopeId)
      }
      // Active scope travels as X-Flect-Scope; for dev tokens also rewrite the
      // token's scope segment so both auth modes agree.
      cfg.scope = scopeId
      if (cfg.token!.startsWith("dev:")) cfg.token = withTokenScope(cfg.token!, scopeId)
      await saveCliConfig(cfg)
      console.log(`✓ active scope → ${path} (${scopeId})`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

program
  .command("login")
  .description("sign in via SSO and store an identity token in ~/.flect/config.json")
  .option("--auth <url>", "auth base (default: config.auth or the broker origin)")
  .action(async (opts: { auth?: string }) => {
    const cfg = await loadCliConfig()
    const { brokerUrl } = await resolveConnection({})
    const authBase = (opts.auth ?? cfg.auth ?? brokerUrl).replace(/\/+$/, "")
    try {
      const start = (await (await fetch(`${authBase}/v1/auth/start`)).json()) as {
        state: string
        url: string
        expires_in: number
      }
      console.log("opening your browser to sign in…")
      console.log(`  ${start.url}`)
      openBrowser(start.url)

      process.stdout.write("waiting for approval")
      const deadline = Date.now() + (start.expires_in ?? 600) * 1000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        process.stdout.write(".")
        const poll = (await (await fetch(`${authBase}/v1/auth/poll/${start.state}`)).json()) as {
          status: string
          token?: string
        }
        if (poll.status === "done" && poll.token) {
          process.stdout.write("\n")
          cfg.token = poll.token
          cfg.auth = authBase
          await saveCliConfig(cfg)
          console.log("✓ signed in — token saved")
          console.log("  next: `flect scope list` then `flect use <scope>`")
          return
        }
        if (poll.status === "expired") die("login expired — run `flect login` again")
      }
      die("login timed out")
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

program
  .command("logout")
  .description("clear the stored token")
  .action(async () => {
    const cfg = await loadCliConfig()
    delete cfg.token
    delete cfg.scope
    await saveCliConfig(cfg)
    console.log("✓ signed out")
  })

withConn(program.command("ps"))
  .description("show the active context (scope, token, api, config)")
  .action(async (opts: ConnOpts) => {
    const { brokerUrl, token } = await resolveConnection(opts)
    let contextLine = "(no scope)"
    if (token) {
      try {
        const { client, scopeId } = await connect(opts)
        const scopes = await client.listScopes().catch(() => [])
        const tenant = tokenInfo(token).tenant ?? "?"
        const where = scopeId ? scopePathOf(scopes, scopeId) : "(no active scope — flect use)"
        contextLine = `${tenant} / ${where}  ● active`
      } catch {
        contextLine = "(scope unresolved)"
      }
    }
    console.log(`  context   ${contextLine}`)
    console.log(`  token     ${maskToken(token)}`)
    console.log(`  api       ${brokerUrl}`)
    console.log(`  config    ${CONFIG_PATH}`)
  })

withConn(program.command("apps"))
  .description("list the apps deployed in the active scope")
  .action(async (opts: ConnOpts) => {
    const { client, scopeId } = await connect(opts)
    const [scopes, apps] = await Promise.all([
      client.listScopes().catch(() => []),
      client.listApps().catch((e) => die(e.message)),
    ])
    console.log(`scope: ${scopePathOf(scopes, scopeId)} (${scopeId})`)
    if (apps.length === 0) return void console.log("  (no apps — deploy one with `flect deploy`)")
    for (const a of apps) {
      const route = a.public
        ? `https://${a.hostname ?? "?"}${a.domain && a.domain !== a.hostname ? `  (custom: ${a.domain} → CNAME ${a.hostname})` : ""}`
        : a.expose
          ? `${a.expose} @ group domain`
          : "private"
      console.log(`  ${a.name.padEnd(16)} ${a.status.padEnd(10)} ${route}`)
      if (a.image) console.log(`  ${"".padEnd(16)} ${"".padEnd(10)} ${a.image}`)
    }
  })

withConn(program.command("whoami"))
  .description("show who you are and where you're pointed")
  .action(async (opts: ConnOpts) => {
    const { brokerUrl, token } = await resolveConnection(opts)
    if (!token) die("no token — run `flect login`")
    const info = tokenInfo(token!)
    const isDev = token!.startsWith("dev:")
    console.log(`broker   : ${brokerUrl}`)
    console.log(`tenant   : ${info.tenant ?? "?"}`)
    console.log(`identity : ${info.identity ?? "?"}${isDev ? "  (dev token)" : "  (SSO)"}`)
    try {
      const { client, scopeId } = await connect(opts)
      const scopes = await client.listScopes().catch(() => [])
      console.log(`scope    : ${scopeId ? `${scopePathOf(scopes, scopeId)} (${scopeId})` : "(none — run `flect use <scope>`)"}`)
    } catch {
      console.log(`scope    : ?`)
    }
  })

const config = program.command("config").description("manage CLI config (~/.flect/config.json)")

config
  .command("set <key> <value>")
  .description("set a config value: `flect config set broker <url>` or `token <tok>`")
  .action(async (key: string, value: string) => {
    if (!["broker", "token", "auth", "scope"].includes(key)) die(`unknown key "${key}" (use: broker | token | auth | scope)`)
    const cfg = await loadCliConfig()
    cfg[key as keyof CliConfig] = value
    await saveCliConfig(cfg)
    console.log(`✓ ${key} = ${key === "token" ? maskToken(value) : value}`)
    console.log(`  saved to ${CONFIG_PATH}`)
  })

config
  .command("get [key]")
  .description("print config (token masked)")
  .action(async (key?: string) => {
    const cfg = await loadCliConfig()
    if (key === "broker") return void console.log(cfg.broker ?? "(unset)")
    if (key === "token") return void console.log(maskToken(cfg.token))
    console.log(`broker : ${cfg.broker ?? "(unset)"}`)
    console.log(`token  : ${maskToken(cfg.token)}`)
    console.log(`file   : ${CONFIG_PATH}`)
  })

config
  .command("path")
  .description("print the config file path")
  .action(() => console.log(CONFIG_PATH))

program
  .command("doctor")
  .description("diagnose your setup: config, broker, auth, token, scope, providers")
  .option("--broker <url>", "broker URL (default: FLECT_BROKER_URL)")
  .option("--token <token>", "token (default: FLECT_TOKEN)")
  .action(async (opts: { broker?: string; token?: string }) => {
    const { runDoctor } = await import("./doctor.js")
    process.exitCode = await runDoctor(opts)
  })

program
  .command("resolve <name>")
  .description("inspect a binding's manifest from the broker (secrets redacted)")
  .option("--broker <url>", "broker URL (default: FLECT_BROKER_URL)")
  .option("--token <token>", "runtime token (default: FLECT_TOKEN)")
  .action(async (name: string, opts: { broker?: string; token?: string }) => {
    const client = new BrokerClient(await brokerConfig(opts))
    try {
      const { manifest } = await client.resolve(name)
      const safe = { ...manifest, connection: redactConnection((manifest["connection"] ?? {}) as Record<string, unknown>) }
      console.log(JSON.stringify(safe, null, 2))
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

program.parseAsync().catch((err) => die(err instanceof Error ? err.message : String(err)))
