/**
 * Thin HTTP client over the broker's management + resolve APIs. The CLI is a
 * client of the control plane and nothing more (RFC-0010). Auth is the runtime
 * token; the dev token `dev:<tenant>:<scopeId>` also tells the CLI which scope
 * to target for resource/binding creation.
 */

import type { BindingKind } from "./config.js"
export type { BindingKind } from "./config.js"

export interface BrokerConfig {
  brokerUrl: string
  token: string
  /** Active scope, sent as `X-Flect-Scope` (identity JWTs are not scope-bound). */
  scope?: string
  /** Active org id, sent as `X-Org-Id` — the broker's tenant when the identity
   *  token carries no org_id (tenancy delegated to org-service). */
  orgId?: string
}

export interface ProviderRow {
  id: string
  kind: string
  bindingKind: BindingKind
  region: string
  endpoint: string
  status: string
}

export interface ScopeRow {
  id: string
  kind: "workspace" | "project" | "environment"
  parentId: string | null
  name: string
  slug: string
  status: string
}

export interface AppRow {
  id: string
  name: string
  status: string
  image: string | null
  public: boolean
  expose: string | null
  domain: string | null
  hostname: string | null
  jobId: string | null
}

export interface PageRow {
  id: string
  name: string
  status: string
  repo: string | null
  ref: string
  template: string | null
  domain: string | null
  hostname: string | null
  jobId: string | null
  currentBuildId: string | null
  lastBuildId: string | null
  failureReason: string | null
}

export interface PageBuildRow {
  buildId: string
  ref: string
  status: "building" | "succeeded" | "failed"
  commit?: string | null
  reason?: string | null
  /** True for the build `current` points at — not necessarily the newest one. */
  current: boolean
}

/** One row of the control plane's event log (`flect events`). */
export interface EventRow {
  /** Position in the tenant's log — monotonic, and what `--since` takes. */
  seq: number
  at: string
  type: string
  streamId: string
  streamType: string
  version: number
  actor: string
  correlationId?: string
  causationId?: string
  payload: Record<string, unknown>
}

export interface ResourceRow {
  id: string
  kind: BindingKind
  scopeId: string
  providerId: string
  name: string
  /** The public ref shown to users and written to flect.toml, e.g. "notes-db-a1b2c3d4". */
  externalRef: string | null
  status: string
  failureReason: string | null
  /** Written in flect.toml as `res_<shortId>` (RFC-0019); absent from an older broker. */
  shortId?: string | null
  /** The apps whose `uses` name a binding to it (RFC-0019); absent from an older broker. */
  usedBy?: Array<{ appId: string; app: string; binding: string }>
}

/** A binding of the scope as the broker resolves it. */
export interface BindingRow {
  bindingId: string
  bindingName: string
  kind: BindingKind
  scopeId: string
  resourceId: string | null
  resolvable: boolean
}

/** `res_<shortId>` when the broker gave the resource one, else its full id. */
export function resourceRef(r: Pick<ResourceRow, "id" | "shortId">): string {
  return r.shortId ? `res_${r.shortId}` : r.id
}

export class BrokerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "BrokerError"
  }
}

/** Decode a token's caller info: dev tokens by segment, JWTs by payload claims. */
export function tokenInfo(token: string): { tenant?: string; identity?: string } {
  if (token.startsWith("dev:")) {
    const p = token.split(":")
    return { tenant: p[1], identity: p[3] ?? "dev" }
  }
  try {
    const seg = token.split(".")[1]
    if (!seg) return {}
    const claims = JSON.parse(Buffer.from(seg, "base64url").toString()) as { org_id?: string; sub?: string }
    return { tenant: claims.org_id, identity: claims.sub }
  } catch {
    return {}
  }
}

/** Extract the scope id from a dev token `dev:<tenant>:<scopeId>`. */
export function scopeIdFromToken(token: string): string {
  const parts = token.split(":")
  if (parts[0] === "dev" && parts[2]) return parts[2]
  throw new Error("cannot derive scope from token; expected dev:<tenant>:<scopeId> or pass --scope")
}

/**
 * Rewrite the scope segment of a dev token (`flect use`). Dev tokens carry the
 * active scope; with real auth the token stays identity-level and the active
 * scope becomes CLI context only.
 */
export function withTokenScope(token: string, scopeId: string): string {
  const parts = token.split(":")
  if (parts[0] !== "dev" || !parts[1]) {
    throw new Error("`flect use` currently supports dev tokens (dev:<tenant>:<scopeId>)")
  }
  return `dev:${parts[1]}:${scopeId}${parts[3] ? `:${parts[3]}` : ""}`
}

export class BrokerClient {
  constructor(private readonly cfg: BrokerConfig) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.brokerUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(this.cfg.scope ? { "X-Flect-Scope": this.cfg.scope } : {}),
        ...(this.cfg.orgId ? { "X-Org-Id": this.cfg.orgId } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const err = (data["error"] ?? {}) as { code?: string; message?: string }
      // A 404 with no error envelope means the *route* is missing — usually a
      // broker older than this CLI. Make that actionable rather than "HTTP 404".
      const fallback =
        res.status === 404 && !err.message
          ? `${method} ${path} not found on the broker (is it up to date?)`
          : `HTTP ${res.status} for ${method} ${path}`
      throw new BrokerError(res.status, err.code ?? "ERROR", err.message ?? fallback)
    }
    return data as T
  }

  listProviders(): Promise<ProviderRow[]> {
    return this.call<ProviderRow[]>("GET", "/v1/providers")
  }

  createScope(input: { kind: "workspace" | "project" | "environment"; name: string; slug: string; parentId?: string; scopeId?: string }): Promise<ScopeRow> {
    return this.call<ScopeRow>("POST", "/v1/scopes", input)
  }

  listScopes(): Promise<ScopeRow[]> {
    return this.call<ScopeRow[]>("GET", "/v1/scopes")
  }

  listApps(): Promise<AppRow[]> {
    return this.call<AppRow[]>("GET", "/v1/apps")
  }

  /** The event log, oldest first. Scoped to the active scope unless `all`. */
  listEvents(q: {
    stream?: string
    correlation?: string
    type?: string
    since?: number
    limit?: number
    all?: boolean
  } = {}): Promise<EventRow[]> {
    const qs = new URLSearchParams()
    if (q.stream) qs.set("stream", q.stream)
    if (q.correlation) qs.set("correlation", q.correlation)
    if (q.type) qs.set("type", q.type)
    if (q.since !== undefined) qs.set("since", String(q.since))
    if (q.limit !== undefined) qs.set("limit", String(q.limit))
    if (q.all) qs.set("all", "1")
    const s = qs.toString()
    return this.call<EventRow[]>("GET", `/v1/events${s ? `?${s}` : ""}`)
  }

  requestResource(input: { kind: BindingKind; scopeId: string; providerId: string; name: string }): Promise<{ id: string }> {
    return this.call("POST", "/v1/resources", input)
  }

  runProvisioner(): Promise<{ provisioned: string[]; failed: string[]; deprovisioned: string[] }> {
    return this.call("POST", "/v1/provisioner/run", {})
  }

  listResources(kind?: BindingKind): Promise<ResourceRow[]> {
    return this.call<ResourceRow[]>("GET", `/v1/resources${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`)
  }

  getResource(ref: string): Promise<ResourceRow> {
    return this.call<ResourceRow>("GET", `/v1/resources/${encodeURIComponent(ref)}`)
  }

  /** Refused (409 RESOURCE_BOUND) while bindings point at it, unless `force` removes them first. */
  deprovisionResource(ref: string, opts: { force?: boolean } = {}): Promise<ResourceRow> {
    return this.call<ResourceRow>("POST", `/v1/resources/${encodeURIComponent(ref)}/deprovision`, opts.force ? { force: true } : {})
  }

  listBindings(): Promise<BindingRow[]> {
    return this.call<BindingRow[]>("GET", "/v1/bindings")
  }

  /** Set one secret of an app in the active scope. The answer has names only. */
  setSecret(app: string, name: string, value: string): Promise<{ names: string[] }> {
    return this.call("POST", `/v1/secrets/${encodeURIComponent(app)}/${encodeURIComponent(name)}`, { value })
  }

  unsetSecret(app: string, name: string): Promise<{ names: string[] }> {
    return this.call("POST", `/v1/secrets/${encodeURIComponent(app)}/${encodeURIComponent(name)}/unset`, {})
  }

  /** The names of an app's secrets in the active scope (never values). */
  listSecrets(app: string): Promise<{ names: string[] }> {
    return this.call("GET", `/v1/secrets/${encodeURIComponent(app)}`)
  }

  /** The names of the vars the app's last deployment kept (never values). */
  keptVarNames(appId: string): Promise<{ names: string[] }> {
    return this.call("GET", `/v1/apps/${encodeURIComponent(appId)}/vars`)
  }

  declareBinding(input: { scopeId: string; name: string; kind: BindingKind }): Promise<{ id: string; status: string }> {
    return this.call("POST", "/v1/bindings", input)
  }

  bind(bindingId: string, resourceId: string): Promise<{ status: string }> {
    return this.call("POST", `/v1/bindings/${encodeURIComponent(bindingId)}/bind`, { resourceId })
  }

  resolve(name: string): Promise<{ manifest: Record<string, unknown> }> {
    return this.call("GET", `/v1/bindings/${encodeURIComponent(name)}/resolve`)
  }

  declareApp(input: {
    name: string
    image?: string
    port?: number
    public?: boolean
    expose?: string
    domain?: string
    replicas?: number
    cpuMhz?: number
    memoryMb?: number
    /** `null` disables health checking; omit for the default check. */
    health?: { path?: string; intervalSec?: number; timeoutSec?: number } | null
  }): Promise<{ id: string; name: string; status: string }> {
    return this.call("POST", "/v1/apps", input)
  }

  deployApp(
    appId: string,
    input: {
      image?: string
      vars?: Record<string, string>
      services?: Array<{ binding: string; app: string }>
      /** The bindings the app may resolve (RFC-0019); omit to keep the last list. */
      uses?: string[]
      /** The names of the secrets to render (RFC-0019 §6); omit to keep the last ones. */
      secrets?: string[]
    },
  ): Promise<{ status: string; jobId: string | null; hostname: string | null; failureReason: string | null }> {
    return this.call("POST", `/v1/apps/${encodeURIComponent(appId)}/deploy`, input)
  }

  listPages(): Promise<PageRow[]> {
    return this.call<PageRow[]>("GET", "/v1/pages")
  }

  /** Reading a page settles a finished build, so `status` is never stale. */
  getPage(pageId: string): Promise<PageRow> {
    return this.call<PageRow>("GET", `/v1/pages/${encodeURIComponent(pageId)}`)
  }

  /** Idempotent by name within the active scope, exactly like `declareApp`. */
  declarePage(input: {
    name: string
    repo?: string
    ref?: string
    template?: string
    title?: string
    github?: string
    domain?: string
  }): Promise<PageRow> {
    return this.call<PageRow>("POST", "/v1/pages", input)
  }

  deployPage(pageId: string, input: { ref?: string } = {}): Promise<PageRow> {
    return this.call<PageRow>("POST", `/v1/pages/${encodeURIComponent(pageId)}/deploy`, input)
  }

  pageBuilds(pageId: string): Promise<PageBuildRow[]> {
    return this.call<PageBuildRow[]>("GET", `/v1/pages/${encodeURIComponent(pageId)}/builds`)
  }

  pageBuildLog(pageId: string, buildId: string): Promise<{ log: string }> {
    return this.call("GET", `/v1/pages/${encodeURIComponent(pageId)}/builds/${encodeURIComponent(buildId)}/logs`)
  }

  rollbackPage(pageId: string, toBuildId?: string): Promise<PageRow> {
    return this.call<PageRow>("POST", `/v1/pages/${encodeURIComponent(pageId)}/rollback`, toBuildId ? { toBuildId } : {})
  }

  stopPage(pageId: string): Promise<PageRow> {
    return this.call<PageRow>("POST", `/v1/pages/${encodeURIComponent(pageId)}/stop`, {})
  }
}
