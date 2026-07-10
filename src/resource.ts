/**
 * Resource lifecycle helpers for the `flect db|kv|store` commands. Creating a
 * resource is: pick an active provider for the kind, request provisioning, run
 * the provisioner, and return the resulting resource (with its public ref).
 * The tenant-prefixed internal name never surfaces (RFC-0017).
 */

import type { BindingKind, BrokerClient, ResourceRow } from "./broker-client.js"

export async function createResource(
  client: BrokerClient,
  scopeId: string,
  kind: BindingKind,
  name: string,
): Promise<ResourceRow> {
  const providers = await client.listProviders()
  const provider = providers.find((p) => p.bindingKind === kind && p.status === "active")
  if (!provider) throw new Error(`no active provider for "${kind}" — an operator must register one`)

  const { id } = await client.requestResource({ kind, scopeId, providerId: provider.id, name })
  const run = await client.runProvisioner()
  const resource = await client.getResource(id)
  if (run.failed.includes(id) || resource.status === "failed") {
    throw new Error(`provisioning failed: ${resource.failureReason ?? "unknown"}`)
  }
  return resource
}
