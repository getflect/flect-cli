/**
 * Realize a flect.toml against the broker: for each declared binding, ensure a
 * resource is provisioned by an active provider of the right kind, then declare
 * and bind it. Idempotent via a local `.flect/state.json` cache — re-running
 * `flect deploy` skips bindings already bound.
 *
 * Provider registration is an operator/platform concern (endpoints, admin
 * secrets), so deploy does not register providers; it selects an existing
 * active one per kind and fails clearly if none exists.
 */

import type { BindingDecl, FlectProject } from "./config.js"
import { BrokerClient, type ProviderRow } from "./broker-client.js"

export interface AppDeployStep {
  app: string
  status: "deployed" | "failed"
  hostname?: string | null
  detail?: string
}

/**
 * Deploy each app declared in flect.toml. Global `[vars]` and `[[services]]`
 * are injected into every app (RFC-0016: only FLECT_TOKEN + vars + service URLs
 * reach the container; binding connections resolve through the broker). The
 * shared `[app].domain` is passed to every app so public/expose routing lines up.
 */
export async function deployApps(client: BrokerClient, project: FlectProject): Promise<AppDeployStep[]> {
  const steps: AppDeployStep[] = []

  // Pass 1 — declare EVERY app first. Deploy composes each app's env by looking
  // up its `[[services]]` siblings (findAppByName); a sibling that isn't
  // declared yet resolves to null and its `<BINDING>_SERVICE_URL` is silently
  // dropped. Declaring the whole graph up front makes deploy order irrelevant:
  // a consumer listed before its provider still gets the provider's URL.
  const declared: Array<{ app: (typeof project.apps)[number]; id: string }> = []
  for (const app of project.apps) {
    try {
      const d = await client.declareApp({
        name: app.name,
        image: app.image,
        port: app.port,
        public: app.public,
        expose: app.expose,
        domain: project.domain,
        replicas: app.replicas,
        cpuMhz: app.cpuMhz,
        memoryMb: app.memoryMb,
        // `false` in flect.toml means "no check at all"; absent means default.
        ...(app.health !== undefined ? { health: app.health === false ? null : app.health } : {}),
      })
      declared.push({ app, id: d.id })
    } catch (err) {
      steps.push({ app: app.name, status: "failed", detail: err instanceof Error ? err.message : String(err) })
    }
  }

  // Pass 2 — deploy the declared apps; every sibling URL now resolves.
  for (const { app, id } of declared) {
    try {
      const result = await client.deployApp(id, {
        image: app.image,
        vars: project.vars,
        services: project.services,
      })
      steps.push({
        app: app.name,
        status: result.status === "deployed" ? "deployed" : "failed",
        hostname: result.hostname,
        detail: result.failureReason ?? undefined,
      })
    } catch (err) {
      steps.push({ app: app.name, status: "failed", detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return steps
}

export interface DeployState {
  bindings: Record<string, { resourceId: string; bindingId: string }>
}

export interface DeployStep {
  binding: string
  status: "bound" | "already-bound" | "failed"
  detail?: string
}

export interface DeployIO {
  loadState(): Promise<DeployState>
  saveState(state: DeployState): Promise<void>
}

export async function deploy(
  client: BrokerClient,
  project: FlectProject,
  scopeId: string,
  io: DeployIO,
): Promise<DeployStep[]> {
  const providers = await client.listProviders()
  const state = await io.loadState()
  const steps: DeployStep[] = []

  for (const binding of project.bindings) {
    if (state.bindings[binding.name]) {
      steps.push({ binding: binding.name, status: "already-bound" })
      continue
    }
    try {
      const ids = await realizeBinding(client, project, scopeId, binding, providers)
      state.bindings[binding.name] = ids
      await io.saveState(state)
      steps.push({ binding: binding.name, status: "bound" })
    } catch (err) {
      steps.push({ binding: binding.name, status: "failed", detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return steps
}

async function realizeBinding(
  client: BrokerClient,
  project: FlectProject,
  scopeId: string,
  binding: BindingDecl,
  providers: ProviderRow[],
): Promise<{ resourceId: string; bindingId: string }> {
  const provider = providers.find((p) => p.bindingKind === binding.kind && p.status === "active")
  if (!provider) {
    throw new Error(`no active provider for kind "${binding.kind}" — an operator must register one`)
  }

  const resource = await client.requestResource({
    kind: binding.kind,
    scopeId,
    providerId: provider.id,
    name: binding.resource,
  })
  const run = await client.runProvisioner()
  if (run.failed.includes(resource.id)) {
    throw new Error(`provisioning failed for resource "${binding.resource}"`)
  }

  const declared = await client.declareBinding({ scopeId, name: binding.name, kind: binding.kind })
  await client.bind(declared.id, resource.id)
  return { resourceId: resource.id, bindingId: declared.id }
}
