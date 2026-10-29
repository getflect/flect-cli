/**
 * A services-format file names its scope as a slug path below the org
 * (`workspace/project/environment`, RFC-0019 §4). This turns that path into
 * the short id the broker takes as X-Flect-Scope, the same way `flect use`
 * walks the tree. It never creates a missing segment.
 */

interface Http {
  get<T>(path: string): Promise<T>
}
interface Node {
  slug: string
  id: string
  short_id?: string
}

export class ScopePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ScopePathError"
  }
}

export async function resolveScopePath(http: Http, org: string, path: string): Promise<{ id: string; label: string }> {
  const [ws, proj, env] = path.split("/").filter(Boolean)
  const find = async (url: string, key: string, slug: string, what: string): Promise<Node> => {
    const res = await http.get<Record<string, Node[]>>(url)
    const hit = (res[key] ?? []).find((n) => n.slug === slug)
    if (!hit) throw new ScopePathError(`${what} "${slug}" not found in ${url.replace(/^\/orgs\//, "").replace(/\/(workspaces|projects|envs)/g, "")}`)
    return hit
  }
  let base = `/orgs/${org}`
  let node = await find(`${base}/workspaces`, "workspaces", ws!, "workspace")
  if (proj) {
    base = `${base}/workspaces/${ws}`
    node = await find(`${base}/projects`, "projects", proj, "project")
  }
  if (env) {
    base = `${base}/projects/${proj}`
    node = await find(`${base}/envs`, "envs", env, "environment")
  }
  return { id: node.short_id ?? node.id, label: `${org}/${path}` }
}
