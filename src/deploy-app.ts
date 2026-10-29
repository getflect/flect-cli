/**
 * `flect deploy` for a services-format file (RFC-0019). Two steps:
 *
 *   plan   reads the scope and checks the whole file against it. Nothing is
 *          changed; any `stop` ends the deploy before the first write.
 *   apply  binds the resources, then deploys each service with only its own
 *          uses, calls and vars.
 *
 * No local state: the broker is asked what exists every time.
 */

import { looksSecret, type AppFile } from "./app-file.js"
import { BrokerError, resourceRef, type AppRow, type BindingKind, type BindingRow, type BrokerClient, type ResourceRow } from "./broker-client.js"

type Client = Pick<
  BrokerClient,
  | "getResource" | "listResources" | "listBindings" | "listApps" | "keptVarNames" | "listSecrets"
  | "declareBinding" | "bind" | "declareApp" | "deployApp"
>

export interface BindStep {
  binding: string
  kind: BindingKind
  /** The full resource id, as the broker stores it. */
  resourceId: string
  ref: string
  /** `declare`: no binding of that name yet. `bind`: declared, unbound. `keep`: already this resource. */
  action: "declare" | "bind" | "keep"
  bindingId?: string
}

export interface AppDeployPlan {
  stops: string[]
  warnings: string[]
  binds: BindStep[]
}

export async function planAppDeploy(
  client: Client,
  file: AppFile,
  scope: { id: string; label: string },
  opts: { yes?: boolean } = {},
): Promise<AppDeployPlan> {
  const stops: string[] = []
  const warnings: string[] = []
  const binds: BindStep[] = []

  // Secrets: every listed name must have a value in this scope.
  for (const s of file.services.filter((x) => x.secrets.length > 0)) {
    let set: string[]
    try {
      set = (await client.listSecrets(s.name)).names
    } catch (err) {
      if (err instanceof BrokerError && err.status === 404) {
        stops.push("the broker is older than this CLI (no /v1/secrets); it must be upgraded first")
        break
      }
      throw err
    }
    for (const n of s.secrets.filter((x) => !set.includes(x))) {
      stops.push(`${s.key} needs secret ${n} in ${scope.label}: flect secret set ${s.key} ${n}${file.path !== "flect.toml" ? ` -c ${file.path}` : ""}`)
    }
  }

  // Resources: each id must be a live resource of the right kind in this scope.
  const found = new Map<string, ResourceRow>()
  for (const r of file.resources) {
    try {
      const row = await client.getResource(r.id)
      if (row.kind !== r.kind) stops.push(`${r.binding}: ${r.id} is a ${row.kind}, not a ${r.kind}`)
      else if (row.status !== "provisioned") stops.push(`${r.binding}: ${r.id} is ${row.status}, not provisioned`)
      else found.set(r.binding, row)
    } catch (err) {
      if (err instanceof BrokerError && err.status === 404) stops.push(`${r.binding}: ${r.id} is not a ${r.kind} in ${scope.label}`)
      else throw err
    }
  }

  // Bindings: one name per scope. Reuse ours, refuse one pointing elsewhere.
  const bindings = await client.listBindings()
  const refs = new Map((await client.listResources()).map((r) => [r.id, resourceRef(r)]))
  for (const r of file.resources) {
    const res = found.get(r.binding)
    if (!res) continue
    const ref = resourceRef(res)
    const row: BindingRow | undefined = bindings.find((b) => b.bindingName === r.binding)
    if (!row) binds.push({ binding: r.binding, kind: r.kind, resourceId: res.id, ref, action: "declare" })
    else if (row.kind !== r.kind) stops.push(`${r.binding}: ${scope.label} already has a ${row.kind} binding of that name`)
    else if (row.resourceId === res.id) binds.push({ binding: r.binding, kind: r.kind, resourceId: res.id, ref, action: "keep", bindingId: row.bindingId })
    else if (row.resourceId === null) binds.push({ binding: r.binding, kind: r.kind, resourceId: res.id, ref, action: "bind", bindingId: row.bindingId })
    else {
      stops.push(
        `${r.binding}: ${scope.label} already has a binding "${r.binding}" pointing at ${refs.get(row.resourceId) ?? row.resourceId}; ` +
          `binding names are one per scope, so rename it in this file`,
      )
    }
  }

  // Kept vars a deploy would drop: a secret must not vanish by being forgotten.
  const apps = (await client.listApps()).filter((a) => a.status !== "deleted")
  for (const s of file.services) {
    const existing = apps.find((a) => a.name === s.name)
    if (!existing) continue
    let kept: string[]
    try {
      kept = (await client.keptVarNames(existing.id)).names
    } catch (err) {
      if (err instanceof BrokerError && err.status === 404) {
        stops.push("the broker is older than this CLI (no GET /v1/apps/:id/vars); it must be upgraded first")
        break
      }
      throw err
    }
    const keep = new Set([...Object.keys(s.vars), ...s.secrets])
    const dropped = kept.filter((n) => !keep.has(n))
    if (dropped.length === 0) continue
    const msg = `${s.key}: the last deploy kept ${dropped.join(", ")}, which ${file.path} no longer has`
    if (opts.yes) warnings.push(`${msg}; dropping (--yes)`)
    else stops.push(`${msg}; add them to vars or secrets, or pass --yes to drop them`)
  }

  // Warnings.
  for (const r of file.resources) {
    if (!file.services.some((s) => s.uses.includes(r.binding))) warnings.push(`${r.binding} is not in any service's uses`)
  }
  const secretLike = new Set(file.services.flatMap((s) => Object.keys(s.vars).filter(looksSecret)))
  for (const n of secretLike) warnings.push(`${n} looks like a secret; it belongs in secrets, not vars`)
  const names = new Set(file.services.map((s) => s.name))
  for (const a of apps as AppRow[]) {
    if (a.name.startsWith(`${file.name}-`) && !names.has(a.name) && a.status !== "stopped") {
      warnings.push(`${a.name} runs in ${scope.label} but is not in ${file.path}; it keeps running until it is deleted`)
    }
  }

  return { stops, warnings, binds }
}

export interface ServiceStep {
  service: string
  app: string
  status: "deployed" | "failed"
  hostname?: string | null
  detail?: string
}

/** Bind, then declare every service, then deploy each with only what it lists. */
export async function applyAppDeploy(
  client: Client,
  file: AppFile,
  plan: AppDeployPlan,
  scopeId: string,
): Promise<{ binds: Array<BindStep & { ok: boolean; detail?: string }>; services: ServiceStep[] }> {
  const binds: Array<BindStep & { ok: boolean; detail?: string }> = []
  for (const b of plan.binds) {
    try {
      if (b.action === "declare") {
        const d = await client.declareBinding({ scopeId, name: b.binding, kind: b.kind })
        await client.bind(d.id, b.resourceId)
      } else if (b.action === "bind") {
        await client.bind(b.bindingId!, b.resourceId)
      }
      binds.push({ ...b, ok: true })
    } catch (err) {
      binds.push({ ...b, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  const services: ServiceStep[] = []
  if (binds.some((b) => !b.ok)) return { binds, services }

  // Declare all first: a service's `calls` look its siblings up by name.
  const nameOf = new Map(file.services.map((s) => [s.key, s.name]))
  const declared: Array<{ s: AppFile["services"][number]; id: string }> = []
  for (const s of file.services) {
    try {
      const d = await client.declareApp({
        name: s.name,
        image: s.image,
        port: s.port,
        public: s.public,
        expose: s.expose,
        domain: file.domain,
        replicas: s.replicas,
        cpuMhz: s.cpuMhz,
        memoryMb: s.memoryMb,
        ...(s.health !== undefined ? { health: s.health === false ? null : s.health } : {}),
      })
      declared.push({ s, id: d.id })
    } catch (err) {
      services.push({ service: s.key, app: s.name, status: "failed", detail: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const { s, id } of declared) {
    try {
      const r = await client.deployApp(id, {
        image: s.image,
        vars: s.vars,
        // `binding` is what the env name is made from: api → API_SERVICE_URL.
        services: s.calls.map((c) => ({ binding: c, app: nameOf.get(c)! })),
        uses: s.uses,
        secrets: s.secrets,
      })
      services.push({
        service: s.key,
        app: s.name,
        status: r.status === "deployed" ? "deployed" : "failed",
        hostname: r.hostname,
        detail: r.failureReason ?? undefined,
      })
    } catch (err) {
      services.push({ service: s.key, app: s.name, status: "failed", detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return { binds, services }
}
