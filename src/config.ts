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

export interface AppDecl {
  name: string
  image?: string
  port?: number
  public?: boolean
  expose?: string
  replicas?: number
  cpuMhz?: number
  memoryMb?: number
}

export interface ServiceDecl {
  binding: string
  app: string
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
    }
  })
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

  const name = str(doc["name"]) ?? str(appSection["name"])
  if (!name) throw new FlectTomlError('a project name is required (top-level "name" or [app].name)')

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
