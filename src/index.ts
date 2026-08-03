#!/usr/bin/env node
/**
 * Flect CLI — identity & tenancy (delegated to the baseworks plane) plus the
 * control-plane deploy surface.
 *
 * Identity / tenancy (auth · iam · org-service):
 *   flect login | logout        sign in / out (SSO device flow)
 *   flect iam whoami            who am I
 *   flect org | ws | proj | env  the org → workspace → project → env tree
 *   flect use <path> | ls | ps   switch / show the active scope
 *   flect access …              PDP (role / check)
 *
 * Control plane (broker):
 *   flect init                 scaffold flect.toml
 *   flect dev                  generate flect.local.json so createEnv() runs locally
 *   flect bindings             list bindings declared in flect.toml
 *   flect db|kv|store create   create a resource (also: list, status, delete)
 *   flect deploy               realize flect.toml against the broker
 *   flect page deploy|ls|…     build and serve a static site from git
 *   flect resolve DB           inspect a binding's manifest (secrets redacted)
 *   flect config set broker …  persist broker URL in ~/.flect/config.json
 */

import { writeFile, readFile, mkdir, access, appendFile } from "node:fs/promises"
import { basename } from "node:path"
import { Command } from "commander"
import { loadFlectToml } from "./config.js"
import { generateLocalConfig } from "./local.js"
import { BrokerClient, type BindingKind, type PageRow } from "./broker-client.js"
import { createResource } from "./resource.js"
import { deploy, deployApps, type DeployState } from "./deploy.js"
import { flectTomlTemplate, GITIGNORE_LINES, redactConnection } from "./scaffold.js"
import { addAuthCommands } from "@baseworks/auth/cli"
import { buildIamCommand } from "@baseworks/iam/cli"
import {
  addGlobalCommands,
  buildOrgCommand,
  buildWsCommand,
  buildProjCommand,
  buildEnvCommand,
  buildAccessCommand,
} from "@baseworks/org/cli"
import {
  ctx,
  iamHttp,
  orgHttp,
  getAuthBase,
  saveIdentityToken,
  clearIdentity,
  getBrokerScope,
  getBrokerScopePath,
  getContextOrgId,
  APP_BASE,
} from "./lib/context.js"
import {
  loadCliConfig,
  saveCliConfig,
  resolveConnection,
  maskToken,
  CONFIG_PATH,
  type CliConfig,
} from "./cli-config.js"

const exists = (p: string) => access(p).then(() => true).catch(() => false)

const die = (msg: string): never => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/** Resolve broker+token (flag > env > ~/.flect/config.json > default); token required. */
async function brokerConfig(opts: { broker?: string; token?: string }) {
  const { brokerUrl, token } = await resolveConnection(opts)
  if (!token) {
    die("no token — run `flect login`, set FLECT_TOKEN, or pass --token")
  }
  return { brokerUrl, token: token! }
}

const program = new Command()
program
  .name("flect")
  .description("Flect platform CLI — identity, tenancy, and deploys through the control plane")
  .version("0.2.0")
  // Required so options after a subcommand (e.g. `ws create --org acme`) bind to
  // the subcommand — the org/ws/proj/env noun commands enable positional options.
  .enablePositionalOptions()

// ── Identity & tenancy plane (login · iam · org/ws/proj/env · use/ls/ps) ──────
// Delegated to the shared baseworks capability plane: login/logout from auth,
// identity from iam, the org tree + context + PDP from org. One identity token
// (from `flect login`) is accepted across all three. Config + bases live in
// ./lib/context.ts (FLECT_URL gateway, or FLECT_{AUTH,IAM,ORG}_URL per service).
const orgDeps = { http: orgHttp, ctx, appBase: APP_BASE, cliName: "flect" }

addAuthCommands(program, {
  authBase: getAuthBase,
  cliName: "flect",
  onToken: saveIdentityToken,
  onLogout: clearIdentity,
})
program.addCommand(buildIamCommand({ http: iamHttp, cliName: "flect" }))
addGlobalCommands(program, orgDeps)
program.addCommand(buildOrgCommand(orgDeps))
program.addCommand(buildWsCommand(orgDeps))
program.addCommand(buildProjCommand(orgDeps))
program.addCommand(buildEnvCommand(orgDeps))
program.addCommand(buildAccessCommand(orgDeps))
program.addCommand(
  new Command("whoami").description("show the current user (alias: flect iam whoami)").action(async () => {
    await program.parseAsync(["", "", "iam", "whoami"])
  }),
)

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
  .option("--scope <scopeId>", "target org-service scope id (default: the active scope from `flect use`)")
  .action(async (opts: { broker?: string; token?: string; scope?: string }) => {
    const project = await loadFlectToml().catch((e) => die(e.message))
    const cfg = await brokerConfig(opts)
    // The deploy target is the active org-service scope (set by `flect use`);
    // --scope overrides with an explicit scope id. Tenancy is delegated to
    // org-service, so the broker treats this id as opaque.
    const scopeId = opts.scope ?? getBrokerScope()
    if (!scopeId) return die("no target scope — run `flect use <org/ws/proj/env>` first (or pass --scope)")
    console.log(`scope: ${getBrokerScopePath() ?? scopeId}`)
    if (project.region) console.log(`region: ${project.region}`)
    // The client must carry the scope so app deploys (which read X-Flect-Scope)
    // land in the same scope as the provisioned bindings.
    const client = new BrokerClient({ ...cfg, scope: scopeId, orgId: getContextOrgId() })

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
    .option("--scope <scopeId>", "target org-service scope id (default: active scope from `flect use`)")
}

type ConnOpts = { broker?: string; token?: string; scope?: string }
async function connect(opts: ConnOpts): Promise<{ client: BrokerClient; scopeId: string }> {
  const cfg = await brokerConfig(opts)
  // Active scope: --scope flag > the org-service scope set by `flect use`.
  const scopeId = opts.scope ?? getBrokerScope() ?? ""
  return { client: new BrokerClient({ ...cfg, scope: scopeId || undefined, orgId: getContextOrgId() }), scopeId }
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

withConn(program.command("apps"))
  .description("list the apps deployed in the active scope")
  .action(async (opts: ConnOpts) => {
    const { client, scopeId } = await connect(opts)
    const apps = await client.listApps().catch((e) => die(e.message))
    console.log(`scope: ${getBrokerScopePath() ?? scopeId ?? "(none — run flect use)"}`)
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

// `flect page` talks to the broker, never to Nomad: the broker clones, builds
// and publishes the site, and is the only party holding cluster credentials
// (RFC-0018). Nothing here depends on a local build or a reachable NOMAD_ADDR.
const page = program.command("page").description("static pages — built from git and served by the broker")

/** Resolve a page by name or id within the active scope. */
async function findPage(client: BrokerClient, ref: string): Promise<PageRow> {
  const pages = await client.listPages().catch((e) => die(e.message))
  const hit = pages.find((p) => p.id === ref || p.name === ref)
  if (!hit) die(`no page "${ref}" in this scope — \`flect page ls\` to see them`)
  return hit!
}

/** The page a command acts on: an explicit ref, else the `[page]` block. */
async function targetPage(client: BrokerClient, ref: string | undefined): Promise<PageRow> {
  if (ref) return findPage(client, ref)
  const project = await loadFlectToml().catch((e) => die(e.message))
  if (!project.page) die('no page given and no [page] block in flect.toml (add [page] with repo = "https://github.com/you/site")')
  return findPage(client, project.page!.name)
}

const pageRoute = (p: PageRow) =>
  p.hostname ? `https://${p.hostname}${p.domain ? `  (custom: https://${p.domain})` : ""}` : "(not served yet)"

withConn(page.command("deploy [page]"))
  .description("build and publish the [page] site from flect.toml (or a named page)")
  .option("--ref <ref>", "branch, tag or commit to build (default: flect.toml, else main)")
  .action(async (ref: string | undefined, opts: ConnOpts & { ref?: string }) => {
    const { client } = await connect(opts)
    try {
      // Declare-or-update first so flect.toml stays the source of truth, exactly
      // like `flect deploy` does for apps.
      let target: PageRow
      if (ref) {
        target = await findPage(client, ref)
      } else {
        const project = await loadFlectToml().catch((e) => die(e.message))
        if (!project.page) die('no [page] block in flect.toml (add [page] with repo = "https://github.com/you/site")')
        target = await client.declarePage({ ...project.page!, ...(opts.ref ? { ref: opts.ref } : {}) })
      }

      const started = await client.deployPage(target.id, opts.ref ? { ref: opts.ref } : {})
      console.log(`→ page "${started.name}" building from ${started.repo ?? "?"}@${started.ref} (build ${started.lastBuildId})`)

      const done = await waitForBuild(client, started.id)
      if (done.status === "failed") {
        console.error(`✗ build failed: ${done.failureReason ?? "unknown"}`)
        console.error(`  logs: flect page logs ${done.name}`)
        process.exitCode = 1
        return
      }
      console.log(`✓ page "${done.name}" live`)
      console.log(`  build  ${done.currentBuildId}`)
      console.log(`  url    ${pageRoute(done)}`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

/** Poll until the build settles. The broker settles it on read, so this is just waiting. */
async function waitForBuild(client: BrokerClient, pageId: string, timeoutMs = 20 * 60_000): Promise<PageRow> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const p = await client.getPage(pageId)
    if (p.status !== "building") return p
    if (Date.now() > deadline) die(`timed out waiting for the build (still running — \`flect page status ${p.name}\`)`)
    await new Promise((r) => setTimeout(r, 5_000))
  }
}

withConn(page.command("ls"))
  .description("list the pages in the active scope")
  .action(async (opts: ConnOpts) => {
    const { client, scopeId } = await connect(opts)
    const pages = await client.listPages().catch((e) => die(e.message))
    console.log(`scope: ${getBrokerScopePath() ?? scopeId ?? "(none — run flect use)"}`)
    if (pages.length === 0) return void console.log("  (no pages — declare one with `flect page deploy`)")
    for (const p of pages) {
      console.log(`  ${p.name.padEnd(16)} ${p.status.padEnd(10)} ${pageRoute(p)}`)
      if (p.repo) console.log(`  ${"".padEnd(16)} ${"".padEnd(10)} ${p.repo}@${p.ref}`)
    }
  })

withConn(page.command("status [page]"))
  .description("show one page and its build history")
  .action(async (ref: string | undefined, opts: ConnOpts) => {
    const { client } = await connect(opts)
    try {
      const found = await targetPage(client, ref)
      const p = await client.getPage(found.id)
      console.log(`page   ${p.name}  (${p.id})`)
      console.log(`status ${p.status}${p.failureReason ? `  — ${p.failureReason}` : ""}`)
      console.log(`source ${p.repo ?? "?"}@${p.ref}${p.template ? `  template=${p.template}` : ""}`)
      console.log(`url    ${pageRoute(p)}`)
      const builds = await client.pageBuilds(p.id)
      if (builds.length === 0) return void console.log("builds (none yet)")
      console.log("builds")
      for (const b of builds) {
        const mark = b.current ? "*" : " "
        const note = b.reason ?? b.commit ?? ""
        console.log(`  ${mark} ${b.buildId.padEnd(14)} ${b.status.padEnd(10)} ${b.ref.padEnd(12)} ${note}`)
      }
      console.log("  (* = the build currently served)")
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

withConn(page.command("logs [page]"))
  .description("print a build's log (default: the most recent build)")
  .option("--build <buildId>", "a specific build id (default: the newest)")
  .action(async (ref: string | undefined, opts: ConnOpts & { build?: string }) => {
    const { client } = await connect(opts)
    try {
      const p = await targetPage(client, ref)
      const buildId = opts.build ?? p.lastBuildId
      if (!buildId) die(`page "${p.name}" has no builds yet`)
      const { log } = await client.pageBuildLog(p.id, buildId!)
      // Nomad garbage-collects finished allocations, so an old build's log is
      // simply gone — say that rather than printing nothing.
      if (!log) return void console.log(`(no log for build ${buildId} — the allocation was garbage-collected)`)
      process.stdout.write(log.endsWith("\n") ? log : `${log}\n`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

withConn(page.command("rollback [page]"))
  .description("switch the served content to a previous build (no rebuild)")
  .option("--build <buildId>", "the build to serve (default: the last successful one before the current)")
  .action(async (ref: string | undefined, opts: ConnOpts & { build?: string }) => {
    const { client } = await connect(opts)
    try {
      const p = await targetPage(client, ref)
      const rolled = await client.rollbackPage(p.id, opts.build)
      console.log(`✓ page "${rolled.name}" now serving build ${rolled.currentBuildId}`)
      console.log(`  url    ${pageRoute(rolled)}`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

withConn(page.command("stop [page]"))
  .description("stop serving a page (its builds are kept)")
  .action(async (ref: string | undefined, opts: ConnOpts) => {
    const { client } = await connect(opts)
    try {
      const p = await targetPage(client, ref)
      const stopped = await client.stopPage(p.id)
      console.log(`✓ page "${stopped.name}" → ${stopped.status}`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

const config = program.command("config").description("manage CLI config (~/.flect/config.json)")

config
  .command("set <key> <value>")
  .description("set a config value: `flect config set gatewayUrl <url>` (drives the whole plane), `broker <url>`, or `token <tok>`")
  .action(async (key: string, value: string) => {
    if (!["gatewayUrl", "broker", "token"].includes(key)) die(`unknown key "${key}" (use: gatewayUrl | broker | token)`)
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
    if (key === "gatewayUrl") return void console.log(cfg.gatewayUrl ?? "(unset)")
    if (key === "broker") return void console.log(cfg.broker ?? "(unset)")
    if (key === "token") return void console.log(maskToken(cfg.token))
    console.log(`gateway : ${cfg.gatewayUrl ?? "(unset)"}`)
    console.log(`broker  : ${cfg.broker ?? "(unset)"}`)
    console.log(`token   : ${maskToken(cfg.token)}`)
    console.log(`file    : ${CONFIG_PATH}`)
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
    const client = new BrokerClient({ ...(await brokerConfig(opts)), orgId: getContextOrgId() })
    try {
      const { manifest } = await client.resolve(name)
      const safe = { ...manifest, connection: redactConnection((manifest["connection"] ?? {}) as Record<string, unknown>) }
      console.log(JSON.stringify(safe, null, 2))
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

program.parseAsync().catch((err) => die(err instanceof Error ? err.message : String(err)))
