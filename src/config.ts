/**
 * flect.toml — the project's binding declaration (RFC-0016). Parsed into a
 * normalized list of bindings the CLI acts on. The SDK never reads this file;
 * it is a CLI/deploy artifact.
 */

import { readFile } from "node:fs/promises"
import { parse } from "smol-toml"

export type BindingKind = "database" | "kv" | "storage"

export interface BindingDecl {
  /** Name used in code, e.g. "DB". */
  name: string
  kind: BindingKind
  /** The Flect resource this binding maps to. */
  resource: string
  /** Migrations directory (databases only). */
  migrationsDir?: string
}

/**
 * HTTP health check for an app. Consul probes it; while it fails Traefik keeps
 * the app out of its backend and sibling discovery renders empty, so an app
 * that answers health on a path other than `/healthz` must say so here.
 */
export interface HealthDecl {
  /** Path to probe, e.g. "/api/health". Default "/healthz". */
  path?: string
  /** Seconds between probes. Default 15. */
  intervalSec?: number
  /** Seconds before a probe is considered failed. Default 3. */
  timeoutSec?: number
}

export interface AppDecl {
  name: string
  image?: string
  port?: number
  public?: boolean
  expose?: string
  replicas?: number
  cpuMhz?: number
  memoryMb?: number
  /**
   * `health = "/api/health"` (path only), a `[apps.health]` table, or
   * `health = false` to switch checking off for a workload that serves no
   * HTTP. Absent = the default check.
   */
  health?: HealthDecl | false
}

export interface ServiceDecl {
  binding: string
  app: string
}

/**
 * A static page (`[page]`): a git repository the broker clones, builds and
 * serves (RFC-0018). The build runs in the cluster, not here — the CLI only
 * declares the source, so nothing about the page depends on this machine.
 */
export interface PageDecl {
  /** Page name (defaults to the project name). */
  name: string
  /** Git repository to build, e.g. "https://github.com/dotlabshq/flect-docs". */
  repo: string
  /** Branch, tag or commit sha to build (default "main"). */
  ref?: string
  /** Builder template — "docs" for the Starlight path; omit to run the repo's own build. */
  template?: string
  /** Site title, passed to the template. */
  title?: string
  /** GitHub URL shown in the template's header. */
  github?: string
  /** Custom domain (in addition to the generated hostname). */
  domain?: string
}

export interface FlectProject {
  name: string
  /** Shared public domain for the app group (`[app].domain`). */
  domain?: string
  /**
   * Where this project lives in the scope tree, as a slug path
   * (`workspace/project/environment`, 1–3 segments). `flect deploy` resolves it
   * and CREATES any missing segment — the manifest fully describes where the
   * project deploys, not just what it needs.
   */
  scope?: string
  /** Deployment region. Only `eu` exists today; the field is reserved. */
  region?: string
  runtime?: string
  port?: number
  bindings: BindingDecl[]
  apps: AppDecl[]
  vars: Record<string, string>
  services: ServiceDecl[]
  /** Optional static page (`[page]`). */
  page?: PageDecl
}

interface RawEntry {
  binding?: unknown
  name?: unknown
  migrations_dir?: unknown
}

function entries(value: unknown, kind: BindingKind): BindingDecl[] {
  if (!Array.isArray(value)) return []
  return value.map((raw: RawEntry, i) => {
    if (typeof raw.binding !== "string" || raw.binding.length === 0) {
      throw new FlectTomlError(`[[${section(kind)}]] #${i + 1}: "binding" is required`)
    }
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new FlectTomlError(`[[${section(kind)}]] "${raw.binding}": "name" is required`)
    }
    return {
      name: raw.binding,
      kind,
      resource: raw.name,
      ...(typeof raw.migrations_dir === "string" ? { migrationsDir: raw.migrations_dir } : {}),
    }
  })
}

const section = (kind: BindingKind) => (kind === "database" ? "databases" : kind === "kv" ? "kv" : "stores")

export class FlectTomlError extends Error {
  constructor(message: string) {
    super(`flect.toml: ${message}`)
    this.name = "FlectTomlError"
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

function appEntries(value: unknown): AppDecl[] {
  if (!Array.isArray(value)) return []
  return value.map((raw: Record<string, unknown>, i) => {
    if (typeof raw["name"] !== "string" || raw["name"].length === 0) {
      throw new FlectTomlError(`[[apps]] #${i + 1}: "name" is required`)
    }
    return {
      name: raw["name"],
      image: str(raw["image"]),
      port: num(raw["port"]),
      public: bool(raw["public"]),
      expose: str(raw["expose"]),
      replicas: num(raw["replicas"]),
      cpuMhz: num(raw["cpuMhz"]),
      memoryMb: num(raw["memoryMb"]),
      ...(raw["health"] !== undefined ? { health: healthOf(raw["health"], raw["name"]) } : {}),
    }
  })
}

/** "30s" / "2m" / a bare number of seconds. */
function durationSec(v: unknown, app: string, key: string): number | undefined {
  if (v === undefined) return undefined
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  const m = typeof v === "string" ? /^(\d+)\s*(s|m)?$/.exec(v.trim()) : null
  if (!m) throw new FlectTomlError(`[[apps]] "${app}": health.${key} must be seconds or a duration like "30s"`)
  return Number(m[1]) * (m[2] === "m" ? 60 : 1)
}

/** `false` | "/path" | { path, interval, timeout } → a normalized declaration. */
function healthOf(v: unknown, app: string): HealthDecl | false {
  if (v === false) return false
  if (v === true) return {}
  const raw: Record<string, unknown> =
    typeof v === "string" ? { path: v } : typeof v === "object" && v !== null ? (v as Record<string, unknown>) : (() => {
      throw new FlectTomlError(`[[apps]] "${app}": health must be a path, a table, or false`)
    })()
  const path = str(raw["path"])
  if (path !== undefined && !path.startsWith("/")) {
    throw new FlectTomlError(`[[apps]] "${app}": health path must start with "/" (got "${path}")`)
  }
  const intervalSec = durationSec(raw["interval"], app, "interval")
  const timeoutSec = durationSec(raw["timeout"], app, "timeout")
  return {
    ...(path !== undefined ? { path } : {}),
    ...(intervalSec !== undefined ? { intervalSec } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
  }
}

function serviceEntries(value: unknown): ServiceDecl[] {
  if (!Array.isArray(value)) return []
  return value.map((raw: Record<string, unknown>, i) => {
    if (typeof raw["binding"] !== "string" || typeof raw["app"] !== "string") {
      throw new FlectTomlError(`[[services]] #${i + 1}: "binding" and "app" are required`)
    }
    return { binding: raw["binding"], app: raw["app"] }
  })
}

function varsOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v
  return out
}

/** Parse flect.toml text into a normalized project. Supports the single-app
 * form (top-level `name` + bindings) and the app-group form (`[app]` + `[[apps]]`). */
export function parseFlectToml(text: string): FlectProject {
  const doc = parse(text) as Record<string, unknown>
  const appSection = (doc["app"] as Record<string, unknown> | undefined) ?? {}

  // A pages-only repo has nothing but `[page]`, so its name stands in for the
  // project's — no dummy top-level `name` just to satisfy the parser.
  const pageName = str((doc["page"] as Record<string, unknown> | undefined)?.["name"])
  const name = str(doc["name"]) ?? str(appSection["name"]) ?? pageName
  if (!name) throw new FlectTomlError('a project name is required (top-level "name", [app].name or [page].name)')

  const bindings = [
    ...entries(doc["databases"], "database"),
    ...entries(doc["kv"], "kv"),
    ...entries(doc["stores"], "storage"),
  ]
  const names = new Set<string>()
  for (const b of bindings) {
    if (names.has(b.name)) throw new FlectTomlError(`duplicate binding name "${b.name}"`)
    names.add(b.name)
  }

  const apps = appEntries(doc["apps"])
  const publicApps = apps.filter((a) => a.public)
  if (publicApps.length > 1) throw new FlectTomlError("only one app may be public (it owns the domain)")

  const scope = str(doc["scope"]) ?? str(appSection["scope"])
  if (scope !== undefined) {
    const segments = scope.split("/").filter(Boolean)
    if (segments.length === 0 || segments.length > 3) {
      throw new FlectTomlError(`"scope" must be a 1–3 segment slug path (workspace/project/environment), got "${scope}"`)
    }
  }

  const region = str(doc["region"]) ?? str(appSection["region"])
  if (region !== undefined && region !== "eu") {
    throw new FlectTomlError(`region "${region}" is not available yet — only "eu" exists today`)
  }

  const pageSection = doc["page"] as Record<string, unknown> | undefined
  let page: PageDecl | undefined
  if (pageSection) {
    const repo = str(pageSection["repo"])
    if (!repo) {
      throw new FlectTomlError(
        str(pageSection["dir"])
          ? '[page]: "dir" is gone — pages are built from git now. Replace it with repo = "https://github.com/you/site"'
          : '[page]: "repo" (the git repository to build) is required',
      )
    }
    const opt = (key: string) => (str(pageSection[key]) ? { [key]: str(pageSection[key])! } : {})
    page = {
      name: str(pageSection["name"]) ?? name,
      repo,
      ...opt("ref"),
      ...opt("template"),
      ...opt("title"),
      ...opt("github"),
      ...opt("domain"),
    }
  }

  return {
    name,
    domain: str(appSection["domain"]),
    scope,
    region,
    runtime: str(doc["runtime"]),
    port: num(doc["port"]),
    bindings,
    apps,
    vars: varsOf(doc["vars"]),
    services: serviceEntries(doc["services"]),
    ...(page ? { page } : {}),
  }
}

export async function loadFlectToml(path = "flect.toml"): Promise<FlectProject> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    throw new FlectTomlError(`not found at "${path}" — run \`flect init\` first`)
  }
  return parseFlectToml(text)
}
