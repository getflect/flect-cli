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
 *   flect resolve DB           inspect a binding's manifest (secrets redacted)
 *   flect config set broker …  persist broker URL in ~/.flect/config.json
 */

import { writeFile, readFile, mkdir, access, appendFile } from "node:fs/promises"
import { basename } from "node:path"
import { Command } from "commander"
import { loadFlectToml } from "./config.js"
import { generateLocalConfig } from "./local.js"
import { BrokerClient, type BindingKind } from "./broker-client.js"
import { createResource } from "./resource.js"
import { deploy, deployApps, type DeployState } from "./deploy.js"
import { deployPage } from "./page.js"
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

const page = program.command("page").description("static pages — serve a built site over Caddy on Nomad")

page
  .command("deploy")
  .description("serve the [page] static site from flect.toml")
  .option("--nomad <url>", "Nomad address (default: NOMAD_ADDR)")
  .option("--dc <dc>", "Nomad datacenter (default: NOMAD_DATACENTER or eu)")
  .action(async (opts: { nomad?: string; dc?: string }) => {
    const project = await loadFlectToml().catch((e) => die(e.message))
    if (!project.page) die('no [page] block in flect.toml (add [page] with dir = "./dist")')
    const nomadAddr = opts.nomad ?? process.env["NOMAD_ADDR"] ?? process.env["FLECT_NOMAD_ADDR"]
    if (!nomadAddr) return die("no Nomad address — pass --nomad or set NOMAD_ADDR")
    try {
      const res = await deployPage(project.page!, {
        nomadAddr,
        datacenter: opts.dc ?? process.env["NOMAD_DATACENTER"] ?? "eu",
        networkMode: (process.env["FLECT_NOMAD_NETWORK_MODE"] as "host" | "bridge") ?? "bridge",
      })
      console.log(`✓ page "${project.page!.name}" deployed`)
      console.log(`  job    ${res.jobId}`)
      console.log(`  url    https://${res.hostname}`)
      console.log("  (local: reach it at the job's host port — `nomad job status <job>`)")
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
