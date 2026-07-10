/**
 * Slug-path addressing for scopes: `saas/scanopy/dev` walks the scope tree by
 * slug from the roots. Also the reverse: render a scope id as its full path
 * for display (`flect ps`, `flect whoami`).
 */

import type { ScopeRow } from "./broker-client.js"

/** Resolve a slug path (e.g. "saas/scanopy/dev") to a scope id. */
export function resolveScopePath(scopes: ScopeRow[], path: string): string {
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0) throw new Error("empty scope path")

  let parentId: string | null = null
  let current: ScopeRow | undefined
  for (const slug of segments) {
    current = scopes.find((s) => s.parentId === parentId && (s.slug === slug || s.name === slug))
    if (!current) {
      const at = parentId === null ? "root" : `under "${segments[segments.indexOf(slug) - 1]}"`
      throw new Error(`scope "${slug}" not found ${at} — see \`flect scope list\``)
    }
    parentId = current.id
  }
  return current!.id
}

/** The scope kind at each path depth: workspace / project / environment. */
const KIND_BY_DEPTH = ["workspace", "project", "environment"] as const

/** The subset of BrokerClient that ensureScopePath needs (testable). */
export interface ScopeClient {
  listScopes(): Promise<ScopeRow[]>
  createScope(input: {
    kind: "workspace" | "project" | "environment"
    name: string
    slug: string
    parentId?: string
  }): Promise<ScopeRow>
}

export interface EnsuredScope {
  scopeId: string
  /** Human-readable descriptions of segments that had to be created. */
  created: string[]
}

/**
 * Resolve a slug path to a scope id, CREATING any missing segment along the way
 * (kind by depth: workspace → project → environment). This is what lets
 * `flect deploy` realize the `scope = "ws/proj/env"` declared in flect.toml on
 * a fresh org — the manifest describes where the project lives, and deploy
 * makes it true. Idempotent: existing segments are reused.
 */
export async function ensureScopePath(client: ScopeClient, path: string): Promise<EnsuredScope> {
  const segments = path.split("/").filter(Boolean)
  if (segments.length === 0 || segments.length > 3) {
    throw new Error(`scope path must have 1–3 segments (workspace/project/environment), got "${path}"`)
  }

  const scopes = await client.listScopes()
  const created: string[] = []
  let parentId: string | null = null

  for (const [depth, slug] of segments.entries()) {
    let node = scopes.find((s) => s.parentId === parentId && (s.slug === slug || s.name === slug))
    if (!node) {
      const kind = KIND_BY_DEPTH[depth]!
      node = await client.createScope({
        kind,
        name: slug,
        slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        parentId: parentId ?? undefined,
      })
      scopes.push(node)
      created.push(`${kind} "${slug}"`)
    }
    parentId = node.id
  }

  return { scopeId: parentId!, created }
}

/** Render a scope id as its slug path, e.g. "saas/scanopy/dev". Falls back to the id. */
export function scopePathOf(scopes: ScopeRow[], scopeId: string): string {
  const byId = new Map(scopes.map((s) => [s.id, s]))
  const parts: string[] = []
  let node = byId.get(scopeId)
  if (!node) return scopeId
  while (node) {
    parts.unshift(node.slug)
    node = node.parentId ? byId.get(node.parentId) : undefined
  }
  return parts.join("/")
}
