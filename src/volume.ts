/**
 * A service's `volumes` (RFC-0022): `"/data"` or `{ path, size, owner }`.
 *
 * The same rules as the broker's `parseVolume` (flect packages/catalog), so a
 * file that parses here is not refused there. The broker gets the entries as
 * written; this only checks them before anything is changed.
 */

/** A volume with no size is 1 GiB. */
export const DEFAULT_VOLUME_BYTES = 1024 ** 3
/** The broker takes at most this many per app. */
export const MAX_VOLUMES = 10

export interface VolumeDecl {
  path: string
  sizeBytes: number
  owner?: { uid: number; gid: number }
}

const SIZE_UNITS: Record<string, number> = { "": 1, B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }

/** "10GiB", "512MiB" or a number of bytes; undefined when it is neither. */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : undefined
  if (typeof v !== "string") return undefined
  const m = /^(\d+)\s*(B|KiB|MiB|GiB|TiB)?$/.exec(v.trim())
  if (!m) return undefined
  const n = Number(m[1]) * SIZE_UNITS[m[2] ?? ""]!
  return n > 0 ? n : undefined
}

/** One entry of `volumes`, or why it is not one. */
export function parseVolume(v: unknown): { ok: true; volume: VolumeDecl } | { ok: false; message: string } {
  const raw: Record<string, unknown> | undefined =
    typeof v === "string" ? { path: v } : typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  if (!raw) return { ok: false, message: `a path such as "/data", or { path, size, owner }` }
  const extra = Object.keys(raw).filter((k) => !["path", "size", "owner"].includes(k))
  if (extra.length > 0) return { ok: false, message: `not a field of a volume: ${extra.join(", ")}` }
  const path = raw["path"]
  if (typeof path !== "string" || !path.startsWith("/") || path === "/" || path.split("/").includes("..")) {
    return { ok: false, message: `an absolute directory in the container, not "/" (got ${JSON.stringify(path)})` }
  }
  let sizeBytes = DEFAULT_VOLUME_BYTES
  if (raw["size"] !== undefined) {
    const n = parseSize(raw["size"])
    if (n === undefined) return { ok: false, message: `size is bytes or a size such as "10GiB" (got ${JSON.stringify(raw["size"])})` }
    sizeBytes = n
  }
  let owner: VolumeDecl["owner"]
  if (raw["owner"] !== undefined) {
    const m = typeof raw["owner"] === "string" ? /^(\d{1,10}):(\d{1,10})$/.exec(raw["owner"]) : null
    if (!m) return { ok: false, message: `owner is "uid:gid", e.g. "1000:1000" (got ${JSON.stringify(raw["owner"])})` }
    owner = { uid: Number(m[1]), gid: Number(m[2]) }
  }
  return { ok: true, volume: { path, sizeBytes, ...(owner ? { owner } : {}) } }
}

/** The path of an entry that parsed: `"/data"` or `{ path = "/data" }`. */
export function volumePath(v: unknown): string {
  return typeof v === "string" ? v : String((v as { path: unknown }).path)
}
