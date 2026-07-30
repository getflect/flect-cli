/**
 * `flect page deploy` — serve a built static site over Caddy on Nomad.
 *
 * A page is the simplest workload: no bindings, no runtime — just static files
 * behind Caddy's file-server. The built directory (`[page].dir`) is bind-mounted
 * into a `caddy:2-alpine` container that serves it; the job is registered in
 * Consul with Traefik tags so it routes at its public hostname (prod). Locally,
 * `host` networking is used (no CNI) and the page is reached at its host port.
 *
 * Production note: the richer path (clone a repo → Astro/Starlight build → host
 * volume) lives in `packages/pages/builder` and runs as a Nomad batch job; this
 * command covers the "already-built directory" case end to end.
 */

import { resolve } from "node:path"
import { access } from "node:fs/promises"
import type { PageDecl } from "./config.js"

export interface PageDeployOptions {
  nomadAddr: string
  nomadToken?: string
  datacenter?: string
  /** `host` (local dev, no CNI) or `bridge` (prod). */
  networkMode?: "bridge" | "host"
  appDomain?: string
  fetchImpl?: typeof fetch
}

const shortId = (s: string) => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

const sanitize = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "")

export interface PageDeployResult {
  jobId: string
  hostname: string
  evalId: string
}

/** Build the Caddy Nomad job (pure) for a page serving `absDir`. */
export function buildPageJob(page: PageDecl, absDir: string, opts: PageDeployOptions): { Job: Record<string, unknown> } {
  const name = sanitize(page.name)
  const jobId = `flect-page-${name}-${shortId(absDir)}`
  const routerId = jobId
  const hostname = `${name}-${shortId(absDir)}.${opts.appDomain ?? "up.flect.run"}`
  const hostRule = page.domain
    ? `Host(\`${hostname}\`) || Host(\`${page.domain}\`)`
    : `Host(\`${hostname}\`)`

  return {
    Job: {
      ID: jobId,
      Name: jobId,
      Type: "service",
      Datacenters: [opts.datacenter ?? "eu"],
      TaskGroups: [
        {
          Name: "page",
          Count: 1,
          Networks: [{ Mode: opts.networkMode ?? "bridge", DynamicPorts: [{ Label: "http", To: 80 }] }],
          Tasks: [
            {
              Name: "caddy",
              Driver: "docker",
              Config: {
                image: "caddy:2-alpine",
                ports: ["http"],
                args: ["caddy", "file-server", "--root", "/site", "--listen", ":80", "--browse"],
                mounts: [{ type: "bind", source: absDir, target: "/site", readonly: true }],
              },
              Resources: { CPU: 64, MemoryMB: 64 },
              Services: [
                {
                  Name: jobId,
                  PortLabel: "http",
                  Provider: "consul",
                  Tags: [
                    "traefik.enable=true",
                    `traefik.http.routers.${routerId}.rule=${hostRule}`,
                    `traefik.http.routers.${routerId}.entrypoints=websecure`,
                    `traefik.http.routers.${routerId}.tls=true`,
                    `traefik.http.routers.${routerId}.tls.certresolver=letsencrypt`,
                    "flect",
                    "flect.cloud/type=page",
                  ],
                  Checks: [{ Type: "tcp", Port: "http", Interval: 15_000_000_000, Timeout: 3_000_000_000 }],
                },
              ],
            },
          ],
        },
      ],
    },
  }
}

/** Build + submit the page's Caddy job to Nomad. Returns the job id + hostname. */
export async function deployPage(page: PageDecl, opts: PageDeployOptions): Promise<PageDeployResult> {
  const absDir = resolve(page.dir)
  await access(absDir).catch(() => {
    throw new Error(`page dir not found: ${absDir} (build your site first, then set [page].dir)`)
  })
  const job = buildPageJob(page, absDir, opts)
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const res = await fetchImpl(`${opts.nomadAddr.replace(/\/+$/, "")}/v1/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(opts.nomadToken ? { "X-Nomad-Token": opts.nomadToken } : {}) },
    body: JSON.stringify(job),
  })
  if (!res.ok) throw new Error(`nomad submit failed (${res.status}): ${await res.text().catch(() => "")}`)
  const data = (await res.json()) as { EvalID?: string }
  const hostname = `${sanitize(page.name)}-${shortId(absDir)}.${opts.appDomain ?? "up.flect.run"}`
  return { jobId: (job.Job as { ID: string }).ID, hostname, evalId: data.EvalID ?? "" }
}
