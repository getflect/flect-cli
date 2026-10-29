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
 *   flect config set broker …  persist settings in the active profile's config
 *
 * Profiles: FLECT_PROFILE=<name> keeps a whole config (token, gateway, CA) in
 * ~/.flect/profiles/<name>; FLECT_HOME=<dir> points at any directory.
 */

import { writeFile, readFile, mkdir, access, appendFile } from "node:fs/promises"
import { basename, resolve as resolvePath } from "node:path"
import { createRequire } from "node:module"
import { Command } from "commander"
import { loadFlectToml, parseFlectToml, type FlectProject } from "./config.js"
import { readFlectFile, type AppFile } from "./app-file.js"
import { planAppDeploy, applyAppDeploy } from "./deploy-app.js"
import { resolveScopePath } from "./scope-path.js"
import { generateLocalConfig } from "./local.js"
import { BrokerClient, resourceRef, type BindingKind, type PageRow } from "./broker-client.js"
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
  buildInvitesCommand,
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
  configPath,
  type CliConfig,
} from "./cli-config.js"
import { profileName, trustConfiguredCa } from "./lib/config-home.js"

// A profile for a gateway under a private CA (a local node) carries its CA;
// load it before any HTTPS call is made.
trustConfiguredCa()

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
  // From package.json (one level up from both src/ and dist/), so it cannot drift.
  .version((createRequire(import.meta.url)("../package.json") as { version: string }).version)
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
program.addCommand(buildInvitesCommand(orgDeps))
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
    // The active context below the org is the file's scope.
    const c = ctx.getContext()
    const scope = c?.workspace && c.project && c.env ? `${c.workspace}/${c.project}/${c.env}` : undefined
    await writeFile("flect.toml", flectTomlTemplate(name, scope))
    if (await exists(".gitignore")) await appendFile(".gitignore", GITIGNORE_LINES.join("\n"))
    else await writeFile(".gitignore", GITIGNORE_LINES.join("\n"))
    console.log(`✓ created flect.toml for "${name}"${scope ? ` in ${scope}` : ""}`)
    if (!scope) console.log("  set [app].scope to the workspace/project/environment it deploys to")
    console.log(`  next: \`flect db create ${name}-db\` and paste its id, then \`flect deploy\``)
  })

program
  .command("dev")
  .description("generate flect.local.json from flect.toml (createEnv() runs locally, no broker)")
  .option("-c, --config <file>", "the flect.toml to read", "flect.toml")
  .action(async (opts: { config: string }) => {
    const project = await loadProject(opts.config)
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
  .option("-c, --config <file>", "the flect.toml to read", "flect.toml")
  .action(async (opts: { config: string }) => {
    const read = await readFlectFile(opts.config).catch((e) => die(e.message))
    if (read.format === "services") return printAppFile(read.file)
    const project = parseFlectToml(read.text)
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
  .option("--scope <scopeId>", "target org-service scope id (default: the active scope from `flect use`; not for a services-format file)")
  .option("-c, --config <file>", "the flect.toml to deploy (another scope is another file: flect.dev.toml)", "flect.toml")
  .option("--yes", "drop vars the last deploy kept that the file no longer has")
  .action(async (opts: { broker?: string; token?: string; scope?: string; config: string; yes?: boolean }) => {
    const read = await readFlectFile(opts.config).catch((e) => die(e.message))
    if (read.format === "services") return deployAppFile(read.file, opts)
    console.warn(`warning: ${opts.config} uses the old format ([[apps]]); see RFC-0019 for [services.<name>]`)
    const project = await Promise.resolve().then(() => parseFlectToml(read.text)).catch((e) => die(e.message))
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

/** A file of either format as the old project shape (`flect dev`): resources by id. */
async function loadProject(path: string): Promise<FlectProject> {
  const read = await readFlectFile(path).catch((e) => die(e.message))
  if (read.format === "old") return Promise.resolve().then(() => parseFlectToml(read.text)).catch((e) => die(e.message))
  const f = read.file
  return {
    name: f.name, scope: f.scope, apps: [], vars: {}, services: [],
    bindings: f.resources.map((r) => ({ name: r.binding, kind: r.kind, resource: r.id, ...(r.migrationsDir ? { migrationsDir: r.migrationsDir } : {}) })),
  }
}

function printAppFile(f: AppFile): void {
  console.log(`${f.name} → ${f.scope} — ${f.resources.length} resources, ${f.services.length} services`)
  for (const r of f.resources) console.log(`  resource ${r.binding.padEnd(14)} ${r.kind.padEnd(9)} ${r.id}`)
  for (const s of f.services) {
    const route = s.public ? "public" : s.expose ? `expose ${s.expose}` : "private"
    console.log(`  service  ${s.key.padEnd(14)} ${route}${s.name !== `${f.name}-${s.key}` ? `  (as ${s.name})` : ""}`)
    if (s.uses.length) console.log(`           uses    ${s.uses.join(", ")}`)
    if (s.calls.length) console.log(`           calls   ${s.calls.join(", ")}`)
    if (s.secrets.length) console.log(`           secrets ${s.secrets.join(", ")}`)
  }
}

/** The scope a services-format file deploys to; `--scope` is refused (RFC-0019 §4). */
async function fileScope(f: AppFile, opts: { scope?: string }): Promise<{ id: string; label: string }> {
  if (opts.scope) die(`${f.path} names its scope ([app].scope = "${f.scope}"); --scope cannot send it elsewhere`)
  const org = ctx.getContext()?.org
  if (!org) die("no org selected — run `flect use <org>` first")
  const scope = await resolveScopePath(orgHttp, org!, f.scope).catch((e) => die(e instanceof Error ? e.message : String(e)))
  const active = getBrokerScope()
  if (active && active !== scope.id) console.log(`note: the active scope is ${getBrokerScopePath() ?? active}; ${f.path} deploys to ${scope.label}`)
  return scope
}

async function deployAppFile(f: AppFile, opts: { broker?: string; token?: string; scope?: string; yes?: boolean }): Promise<void> {
  const cfg = await brokerConfig(opts)
  const scope = await fileScope(f, opts)
  console.log(`scope: ${scope.label}  (${f.path})`)
  const client = new BrokerClient({ ...cfg, scope: scope.id, orgId: getContextOrgId() })

  const plan = await planAppDeploy(client, f, scope, { yes: opts.yes }).catch((e) => die(e instanceof Error ? e.message : String(e)))
  for (const w of plan.warnings) console.log(`  ! ${w}`)
  if (plan.stops.length > 0) {
    for (const m of plan.stops) console.error(`  ✗ ${m}`)
    die(`nothing was changed: ${plan.stops.length} problem${plan.stops.length === 1 ? "" : "s"} in ${f.path}`)
  }

  const result = await applyAppDeploy(client, f, plan, scope.id)
  let failed = false
  if (result.binds.length > 0) console.log("resources:")
  for (const b of result.binds) {
    const what = b.action === "keep" ? "bound" : "bound now"
    console.log(`  ${b.ok ? "✓" : "✗"} ${b.binding.padEnd(12)} ${b.ref}  ${b.ok ? what : `failed — ${b.detail}`}`)
    if (!b.ok) failed = true
  }
  if (result.services.length > 0) console.log("services:")
  for (const s of result.services) {
    const where = s.hostname ? ` → https://${s.hostname}` : ""
    console.log(`  ${s.status === "failed" ? "✗" : "✓"} ${s.service.padEnd(16)} ${s.status}${where}${s.detail ? ` — ${s.detail}` : ""}`)
    if (s.status === "failed") failed = true
  }
  if (failed) process.exit(1)
  console.log("deploy complete")
}

/** Add the shared connection flags to a command. */
function withConn(cmd: Command): Command {
  return cmd
    .option("--broker <url>", "broker URL (default: config/env)")
    .option("--token <token>", "runtime token (default: config/env)")
    .option("--scope <scopeId>", "target org-service scope id (default: active scope from `flect use`)")
}

type ConnOpts = { broker?: string; token?: string; scope?: string }

/**
 * For the resource commands: the scope of a services-format file (`-c`, or a
 * flect.toml here in that format), else the active scope.
 */
async function connectForFile(opts: ConnOpts & { config?: string }): Promise<{ client: BrokerClient; scopeId: string; label: string; file?: AppFile }> {
  const path = opts.config ?? (await exists("flect.toml") ? "flect.toml" : undefined)
  const read = path ? await readFlectFile(path).catch((e) => die(e.message)) : undefined
  if (read?.format !== "services") {
    if (opts.config) die(`${opts.config} is not a services-format file; it names no scope`)
    const c = await connect(opts)
    return { ...c, label: opts.scope ?? getBrokerScopePath() ?? (c.scopeId || "(none — run flect use)") }
  }
  const cfg = await brokerConfig(opts)
  const scope = await fileScope(read.file, opts)
  return { client: new BrokerClient({ ...cfg, scope: scope.id, orgId: getContextOrgId() }), scopeId: scope.id, label: scope.label, file: read.file }
}

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
    .description(`create a ${label} resource (in the scope of flect.toml / -c, else the active one)`)
    .option("-c, --config <file>", "create it in the scope this file names")
    .action(async (name: string, opts: ConnOpts & { config?: string }) => {
      const { client, scopeId, label: where, file } = await connectForFile(opts)
      try {
        const r = await createResource(client, scopeId, kind, name)
        console.log(`✓ created ${label} "${r.name}" in ${where} (${r.status})`)
        if (file || r.shortId) console.log(`  ${file?.path ?? "flect.toml"} → id = "${resourceRef(r)}"`)
        else console.log(`  flect.toml → name = "${r.externalRef}"`)
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })

  withConn(group.command("list"))
    .description(`list ${label} resources in the scope`)
    .option("--all", "include deprovisioned ones")
    .option("-c, --config <file>", "list the scope this file names")
    .action(async (opts: ConnOpts & { all?: boolean; config?: string }) => {
      const { client, label: where } = await connectForFile(opts)
      const all = await client.listResources(kind).catch((e) => die(e.message))
      // Deprovisioned resources stay in the log; the list shows what exists.
      const rows = opts.all ? all : all.filter((r) => r.status !== "deprovisioned")
      console.log(`scope: ${where}`)
      if (rows.length === 0) {
        const gone = all.length - rows.length
        return void console.log(`  (no ${label} resources${gone ? `; ${gone} deprovisioned — --all to show` : ""})`)
      }
      for (const r of rows) {
        const users = r.usedBy?.length ? r.usedBy.map((u) => (u.binding === r.usedBy![0]!.binding ? u.app : `${u.app} (${u.binding})`)).join(", ") : "—"
        console.log(`  ${resourceRef(r).padEnd(12)} ${r.name.padEnd(24)} ${r.status.padEnd(14)} used by: ${users}`)
      }
    })

  withConn(group.command("status <ref>"))
    .description(`show a ${label} resource's status`)
    .option("-c, --config <file>", "in the scope this file names")
    .action(async (ref: string, opts: ConnOpts & { config?: string }) => {
      const { client } = await connectForFile(opts)
      try {
        const r = await client.getResource(ref)
        console.log(JSON.stringify(r, null, 2))
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })

  withConn(group.command("delete <ref>"))
    .description(`deprovision a ${label} resource (refused while bound; --force unbinds first)`)
    .option("-c, --config <file>", "in the scope this file names")
    .option("--force", "remove the bindings that point at it first")
    .action(async (ref: string, opts: ConnOpts & { config?: string; force?: boolean }) => {
      const { client } = await connectForFile(opts)
      try {
        const r = await client.deprovisionResource(ref, { force: opts.force })
        console.log(`✓ ${label} "${ref}" → ${r.status}`)
      } catch (err) {
        die(err instanceof Error ? err.message : String(err))
      }
    })
}

// ─── flect secret ───────────────────────────────────────────────────────────
//
// Secrets (RFC-0019 §6): the file lists names, the values go to the broker's
// secret store per service and scope. A value is read from stdin, never from
// an argument, so it stays out of shell history and process lists. Nothing
// here prints a value.

/** The broker app a `<service>` argument means: the file's service key, else the app name itself. */
function secretTarget(file: AppFile | undefined, service: string): string {
  if (!file) return service
  const s = file.services.find((x) => x.key === service || x.name === service)
  if (!s) die(`no [services.${service}] in ${file.path} (services: ${file.services.map((x) => x.key).join(", ")})`)
  return s!.name
}

async function readSecretValue(name: string): Promise<string> {
  if (process.stdin.isTTY) {
    // Typed: hide it, one line.
    process.stdout.write(`${name}: `)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const value = await new Promise<string>((resolve, reject) => {
      let buf = ""
      process.stdin.on("data", (ch: string) => {
        for (const c of ch) {
          if (c === "\r" || c === "\n") return resolve(buf)
          if (c === "\u0003") return reject(new Error("cancelled"))
          if (c === "\u007f") buf = buf.slice(0, -1)
          else buf += c
        }
      })
    }).finally(() => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write("\n")
    })
    return value
  }
  // Piped: all of it, without the one newline `echo` adds.
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")
}

const secret = program.command("secret").description("manage a service's secrets (values from stdin; names only are ever shown)")

withConn(secret.command("set <service> <NAME>"))
  .description("set a secret for a service in the file's scope (the value is read from stdin)")
  .option("-c, --config <file>", "in the scope this file names")
  .action(async (service: string, name: string, opts: ConnOpts & { config?: string }) => {
    const { client, label, file } = await connectForFile(opts)
    const app = secretTarget(file, service)
    const value = await readSecretValue(name).catch((e) => die(e.message))
    if (!value) die("empty value: nothing was set")
    try {
      await client.setSecret(app, name, value!)
      console.log(`✓ ${name} set for ${service} in ${label}; it reaches the service on its next deploy`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

withConn(secret.command("list [service]"))
  .description("the names of the secrets set in the file's scope (every service of the file when none is given)")
  .option("-c, --config <file>", "in the scope this file names")
  .action(async (service: string | undefined, opts: ConnOpts & { config?: string }) => {
    const { client, label, file } = await connectForFile(opts)
    if (!service && !file) die("name a service, or run this next to a services-format flect.toml")
    const targets = service ? [{ key: service, name: secretTarget(file, service), wants: file?.services.find((x) => x.key === service)?.secrets ?? [] }]
      : file!.services.map((s) => ({ key: s.key, name: s.name, wants: s.secrets }))
    console.log(`scope: ${label}`)
    for (const t of targets) {
      const { names } = await client.listSecrets(t.name).catch((e) => die(e.message))
      const missing = t.wants.filter((n) => !names.includes(n))
      const unused = names.filter((n) => file && !t.wants.includes(n))
      console.log(`  ${t.key.padEnd(16)} ${names.length ? names.join(", ") : "—"}`)
      if (missing.length) console.log(`  ${"".padEnd(16)} not set: ${missing.join(", ")}`)
      if (unused.length) console.log(`  ${"".padEnd(16)} set but not listed in ${file!.path}: ${unused.join(", ")}`)
    }
  })

withConn(secret.command("unset <service> <NAME>"))
  .description("remove a secret; the next deploy of a service that lists it stops")
  .option("-c, --config <file>", "in the scope this file names")
  .action(async (service: string, name: string, opts: ConnOpts & { config?: string }) => {
    const { client, label, file } = await connectForFile(opts)
    try {
      await client.unsetSecret(secretTarget(file, service), name)
      console.log(`✓ ${name} removed from ${service} in ${label}`)
    } catch (err) {
      die(err instanceof Error ? err.message : String(err))
    }
  })

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

// ─── flect events ───────────────────────────────────────────────────────────
//
// The control plane is event-sourced, so a deploy's history is not a log file
// somebody wrote — it is the state itself. One command reads it, because the
// log is one thing: apps, pages, resources and bindings are stream-id prefixes
// within it, not separate logs. Filters narrow it; there is no `flect app
// events`.

/** `page-59117479-13da-…` → `page-59117479`: enough to tell streams apart. */
const shortStream = (id: string) => {
  const dash = id.indexOf("-")
  if (dash < 0) return id
  return `${id.slice(0, dash)}-${id.slice(dash + 1).split("-")[0]}`
}

/** Payload keys worth showing first; the rest follow in their own order. */
const PAYLOAD_KEYS = [
  "name", "ref", "buildId", "commit", "jobId", "hostname", "domain", "status",
  "reason", "failureReason", "kind", "externalRef", "secretRef", "bindingId",
  "resourceId", "providerId", "image", "scopeId",
]

/** A one-line digest of an event's payload — primitives only, four at most. */
function summarize(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload)
  const ordered = [
    ...PAYLOAD_KEYS.filter((k) => k in payload),
    ...keys.filter((k) => !PAYLOAD_KEYS.includes(k)),
  ]
  const parts: string[] = []
  for (const k of ordered) {
    const v = payload[k]
    if (v === null || v === undefined || typeof v === "object") continue
    const s = String(v)
    parts.push(`${k}=${s.length > 44 ? `${s.slice(0, 41)}…` : s}`)
    if (parts.length === 4) break
  }
  return parts.join("  ")
}

withConn(program.command("events"))
  .description("read the control plane's event log for the active scope")
  .option("--app <name>", "only this app's stream")
  .option("--page <name>", "only this page's stream")
  .option("--stream <id>", "only this stream (app-…, page-…, resource-…, binding-…)")
  .option("--correlation <id>", "every event of one logical flow")
  .option("--type <types>", "event type(s), comma-separated (e.g. PageBuildFailed)")
  .option("--since <seq>", "only events after this sequence number")
  .option("-n, --limit <n>", "how many of the newest events to show (default 50)")
  .option("--all", "the whole org, including provider and credential streams")
  .option("--json", "raw event rows, one JSON array")
  .action(
    async (
      opts: ConnOpts & {
        app?: string
        page?: string
        stream?: string
        correlation?: string
        type?: string
        since?: string
        limit?: string
        all?: boolean
        json?: boolean
      },
    ) => {
      const { client, scopeId } = await connect(opts)
      const num = (v: string | undefined, what: string) => {
        if (v === undefined) return undefined
        const n = Number(v)
        if (!Number.isFinite(n)) die(`--${what} expects a number, got "${v}"`)
        return n
      }

      // `--app`/`--page` are conveniences over `--stream`: names are what people
      // remember, stream ids are what the log is keyed by.
      let stream = opts.stream
      if (opts.app) {
        const apps = await client.listApps().catch((e) => die(e.message))
        const hit = apps.find((a) => a.name === opts.app || a.id === opts.app)
        if (!hit) die(`no app "${opts.app}" in this scope — \`flect apps\` to see them`)
        stream = hit!.id
      }
      if (opts.page) stream = (await findPage(client, opts.page)).id

      const rows = await client
        .listEvents({
          ...(stream ? { stream } : {}),
          ...(opts.correlation ? { correlation: opts.correlation } : {}),
          ...(opts.type ? { type: opts.type } : {}),
          ...(num(opts.since, "since") !== undefined ? { since: num(opts.since, "since")! } : {}),
          ...(num(opts.limit, "limit") !== undefined ? { limit: num(opts.limit, "limit")! } : {}),
          ...(opts.all ? { all: true } : {}),
        })
        .catch((e) => die(e.message))

      if (opts.json) return void console.log(JSON.stringify(rows, null, 2))

      console.log(`scope: ${opts.all ? "(whole org)" : (getBrokerScopePath() ?? scopeId ?? "(none — run flect use)")}`)
      if (rows.length === 0) return void console.log("  (no events match)")
      for (const e of rows) {
        const at = e.at.replace("T", " ").slice(0, 19)
        console.log(
          `  ${String(e.seq).padStart(6)}  ${at}  ${e.type.padEnd(26)} ${shortStream(e.streamId).padEnd(22)} ${summarize(e.payload)}`,
        )
      }
      const last = rows[rows.length - 1]!
      console.log(`\n  newer events: flect events --since ${last.seq}`)
    },
  )

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
      if (!log) {
        // A build that failed before its task ran (an image that never
        // pulled) has no log at all; its reason is the useful line.
        const build = (await client.pageBuilds(p.id)).find((b) => b.buildId === buildId)
        if (build?.status === "failed" && build.reason) {
          return void console.log(`(no log for build ${buildId}: it failed before it ran — ${build.reason})`)
        }
        return void console.log(`(no log for build ${buildId} — the allocation was garbage-collected)`)
      }
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

const config = program.command("config").description("manage CLI config (the active profile's config.json; `flect config path`)")

config
  .command("set <key> <value>")
  .description("set a config value: `gatewayUrl <url>` (drives the whole plane), `broker <url>`, `token <tok>`, or `caFile <pem>` (trust a private CA)")
  .action(async (key: string, value: string) => {
    if (!["gatewayUrl", "broker", "token", "caFile"].includes(key)) die(`unknown key "${key}" (use: gatewayUrl | broker | token | caFile)`)
    if (key === "caFile") {
      value = resolvePath(value)
      await access(value).catch(() => die(`caFile ${value} does not exist`))
    }
    const cfg = await loadCliConfig()
    cfg[key as keyof CliConfig] = value
    await saveCliConfig(cfg)
    console.log(`✓ ${key} = ${key === "token" ? maskToken(value) : value}`)
    console.log(`  saved to ${configPath()}`)
  })

config
  .command("get [key]")
  .description("print config (token masked)")
  .action(async (key?: string) => {
    const cfg = await loadCliConfig()
    if (key === "gatewayUrl") return void console.log(cfg.gatewayUrl ?? "(unset)")
    if (key === "broker") return void console.log(cfg.broker ?? "(unset)")
    if (key === "token") return void console.log(maskToken(cfg.token))
    console.log(`profile : ${profileName() ?? (process.env["FLECT_HOME"] ? "(FLECT_HOME)" : "(default)")}`)
    console.log(`gateway : ${cfg.gatewayUrl ?? "(unset)"}`)
    console.log(`broker  : ${cfg.broker ?? "(unset)"}`)
    console.log(`token   : ${maskToken(cfg.token)}`)
    console.log(`caFile  : ${cfg.caFile ?? "(unset)"}`)
    console.log(`file    : ${configPath()}`)
  })

config
  .command("path")
  .description("print the config file path")
  .action(() => console.log(configPath()))

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
