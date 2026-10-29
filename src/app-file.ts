/**
 * The services format of flect.toml (RFC-0019): one application in one scope.
 *
 *   [app]                  name, scope (required), domain
 *   [[databases]] / [[kv]] / [[stores]]
 *                          binding + id: a resource created apart, used by id
 *   [vars]                 for every service
 *   [services.<name>]      one microservice: image, port, …, and what it gets:
 *                          uses (bindings), calls (services), vars, secrets
 *
 * Another environment is another file (`flect.dev.toml`). Everything that can
 * be checked without the broker is checked here, so a file that parses is a
 * file whose references all line up.
 */

import { readFile } from "node:fs/promises"
import { parse } from "smol-toml"
import { FlectTomlError, healthOf, isAppFileDoc, type BindingKind, type HealthDecl } from "./config.js"

export interface ResourceEntry {
  /** Name in code: `env.db("DB")`. */
  binding: string
  kind: BindingKind
  /** `res_…` (or a full `resource-…` id): a resource of the file's scope. */
  id: string
  migrationsDir?: string
}

export interface ServiceEntry {
  /** The key in `[services.<key>]`; what `calls` names and the env name derives from. */
  key: string
  /** The broker app it deploys as: `name`, else `<app>-<key>`. */
  name: string
  image?: string
  port?: number
  public?: boolean
  expose?: string
  replicas?: number
  cpuMhz?: number
  memoryMb?: number
  health?: HealthDecl | false
  uses: string[]
  calls: string[]
  /** `[vars]` with this service's own on top (its value wins). */
  vars: Record<string, string>
  secrets: string[]
}

export interface AppFile {
  /** The file it was read from, for messages (`flect.dev.toml`). */
  path: string
  name: string
  /** Slug path below the org: `workspace/project/environment`. */
  scope: string
  domain?: string
  region?: string
  resources: ResourceEntry[]
  services: ServiceEntry[]
}

const KINDS: Array<[string, BindingKind]> = [["databases", "database"], ["kv", "kv"], ["stores", "storage"]]
const CREATE_CMD: Record<BindingKind, string> = { database: "db", kv: "kv", storage: "store" }

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new FlectTomlError(`${where} must be a list of names`)
  return [...new Set(v as string[])]
}

function varsOf(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {}
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new FlectTomlError(`${where} must be a table`)
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") throw new FlectTomlError(`${where}.${k} must be a string`)
    out[k] = x
  }
  return out
}

/** The closest name, for "did you mean". */
function closest(name: string, among: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) d[0]![j] = j
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    return d[a.length]![b.length]!
  }
  const best = among.map((n) => [n, dist(name, n)] as const).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? best[0] : undefined
}

export function parseAppFile(text: string, path = "flect.toml"): AppFile {
  const doc = parse(text) as Record<string, unknown>
  if (!isAppFileDoc(doc)) throw new FlectTomlError("not a services-format file: it has no [services.<name>]")
  if (doc["apps"] !== undefined) throw new FlectTomlError("[services.<name>] and [[apps]] cannot be mixed in one file (RFC-0019)")

  const app = (doc["app"] as Record<string, unknown> | undefined) ?? {}
  const name = str(app["name"])
  if (!name) throw new FlectTomlError('[app].name is required')
  const scope = str(app["scope"])
  if (!scope) {
    throw new FlectTomlError('[app].scope is required: the workspace/project/environment this file deploys to, e.g. "platform/clave/production"')
  }
  const segments = scope.split("/").filter(Boolean)
  if (segments.length === 0 || segments.length > 3) {
    throw new FlectTomlError(`[app].scope must be a 1–3 segment slug path (workspace/project/environment), got "${scope}"`)
  }
  const region = str(app["region"])
  if (region !== undefined && region !== "eu") throw new FlectTomlError(`region "${region}" is not available yet — only "eu" exists today`)

  // Resources.
  const resources: ResourceEntry[] = []
  for (const [section, kind] of KINDS) {
    const list = doc[section]
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new FlectTomlError(`[[${section}]] must be an array of tables`)
    for (const [i, raw] of (list as Array<Record<string, unknown>>).entries()) {
      const binding = str(raw["binding"])
      if (!binding) throw new FlectTomlError(`[[${section}]] #${i + 1}: "binding" is required`)
      if (raw["name"] !== undefined) {
        throw new FlectTomlError(`[[${section}]] "${binding}": resources are used by id here, not created by name; replace name with id = "res_…"`)
      }
      if (typeof raw["id"] === "object") {
        throw new FlectTomlError(`[[${section}]] "${binding}": one file is one scope, so one id; another environment is another file (flect.dev.toml)`)
      }
      const id = str(raw["id"])
      if (!id) {
        throw new FlectTomlError(`[[${section}]] "${binding}" has no id: create one with \`flect ${CREATE_CMD[kind]} create ${name}-${binding.toLowerCase()} -c ${path}\` and add its id = "res_…"`)
      }
      resources.push({ binding, kind, id, ...(str(raw["migrations_dir"]) ? { migrationsDir: str(raw["migrations_dir"])! } : {}) })
    }
  }
  const seen = new Set<string>()
  for (const r of resources) {
    if (seen.has(r.binding)) throw new FlectTomlError(`two resources are named "${r.binding}"`)
    seen.add(r.binding)
  }

  // Services.
  const shared = varsOf(doc["vars"], "[vars]")
  const table = doc["services"] as Record<string, unknown>
  const keys = Object.keys(table)
  if (keys.length === 0) throw new FlectTomlError("no services: add a [services.<name>]")
  const services: ServiceEntry[] = keys.map((key) => {
    const raw = table[key]
    const where = `[services.${key}]`
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FlectTomlError(`${where} must be a table`)
    const s = raw as Record<string, unknown>
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) throw new FlectTomlError(`${where}: a service name is lower-case letters, digits and "-"`)

    const uses = strings(s["uses"], `${where} uses`)
    for (const u of uses) {
      if (!seen.has(u)) {
        const hint = closest(u, [...seen])
        throw new FlectTomlError(`${where} uses "${u}", but no resource has binding = "${u}"${hint ? `; did you mean "${hint}"?` : ""}`)
      }
    }
    const calls = strings(s["calls"], `${where} calls`)
    for (const c of calls) {
      if (c === key) throw new FlectTomlError(`${where} calls itself`)
      if (!keys.includes(c)) {
        const hint = closest(c, keys)
        throw new FlectTomlError(`${where} calls "${c}", but there is no [services.${c}]${hint ? `; did you mean "${hint}"?` : ""}`)
      }
    }
    const secrets = strings(s["secrets"], `${where} secrets`)
    const own = varsOf(s["vars"], `${where}.vars`)
    const vars = { ...shared, ...own }
    for (const n of secrets) {
      if (n in vars) throw new FlectTomlError(`${where}: "${n}" is both a var and a secret`)
    }

    return {
      key,
      name: str(s["name"]) ?? `${name}-${key}`,
      image: str(s["image"]),
      port: num(s["port"]),
      public: bool(s["public"]),
      expose: str(s["expose"]),
      replicas: num(s["replicas"]),
      cpuMhz: num(s["cpuMhz"]),
      memoryMb: num(s["memoryMb"]),
      ...(s["health"] !== undefined ? { health: healthOf(s["health"], key) } : {}),
      uses,
      calls,
      vars,
      secrets,
    }
  })
  if (services.filter((s) => s.public).length > 1) throw new FlectTomlError("only one service may be public (it owns the domain)")
  const names = new Set<string>()
  for (const s of services) {
    if (names.has(s.name)) throw new FlectTomlError(`two services deploy as "${s.name}"`)
    names.add(s.name)
  }

  return {
    path,
    name,
    scope: segments.join("/"),
    ...(str(app["domain"]) ? { domain: str(app["domain"])! } : {}),
    ...(region ? { region } : {}),
    resources,
    services,
  }
}

/** A name that reads like a secret: it belongs in `secrets`, not `vars`. */
export function looksSecret(name: string): boolean {
  return /(_SECRET|_KEY|_TOKEN|_PASSWORD)$/.test(name) || /^(SECRET|PASSWORD|TOKEN)$/.test(name)
}

/** The env var a `calls` entry is given: `api` → `API_SERVICE_URL` (the broker adds `_SERVICE_URL`). */
export function callEnvBinding(key: string): string {
  return key.toUpperCase().replace(/-/g, "_")
}

/** Read a file and tell its format: the old one stays on its own parser. */
export async function readFlectFile(path: string): Promise<{ format: "services"; file: AppFile } | { format: "old"; text: string }> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    throw new FlectTomlError(`not found at "${path}" — run \`flect init\` first`)
  }
  const doc = parse(text) as Record<string, unknown>
  if (!isAppFileDoc(doc)) return { format: "old", text }
  try {
    return { format: "services", file: parseAppFile(text, path) }
  } catch (err) {
    // Say which file: there may be one per scope.
    if (err instanceof FlectTomlError && path !== "flect.toml") err.message = err.message.replace(/^flect\.toml:/, `${path}:`)
    throw err
  }
}
