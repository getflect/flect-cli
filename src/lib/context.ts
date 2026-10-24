/**
 * Shared CLI context for the identity/tenancy plane (login · iam · org · scope).
 *
 * flect delegates identity (auth-service), users (iam-service), and the org tree
 * — org → workspace → project → environment — plus the PDP (org-service) to the
 * shared baseworks capability plane, exactly like the `dtab` CLI. This module is
 * the single source of truth for the plane's config, token, and HTTP clients.
 *
 * It is deliberately separate from `cli-config.ts` (which resolves the *broker*
 * URL + token for `flect deploy` / `db` / `kv` / `resolve`). Both persist to the
 * same `~/.flect/config.json`; the shared `token` key is the identity JWT minted
 * by `flect login`, so a single sign-in works for both the plane and the broker.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createContextManager, type BaseConfig, type ContextManager } from "@baseworks/cli/context"
import { resolveToken } from "@baseworks/cli/config-loader"
import { createApiClient } from "@baseworks/cli/client"

// ─── Types ──────────────────────────────────────────────────────────────────

/** Active scope, written by `flect use` (org → workspace → project → env). */
interface FlectContext extends Record<string, string | undefined> {
  org?: string
  workspace?: string
  project?: string
  env?: string
  orgId?: string
  workspaceId?: string
  projectId?: string
  envId?: string
}

// ─── Context manager ────────────────────────────────────────────────────────
// App name "flect" → ~/.flect/config.json (global) or ./.flect/config.json when
// a project-local config file exists (used to sandbox e2e tests).
//
// @baseworks/cli goes local as soon as a ./.flect/ *directory* exists — but
// `flect deploy` creates that dir for state.json, so after the first deploy
// every plane command in the project ran on an empty config (no token, default
// base → 404). Here the global file is used unless the local file is there.

type FlectConfig = BaseConfig & { context?: FlectContext }

const localCtx = createContextManager<FlectContext>("flect")
const GLOBAL_DIR = join(homedir(), ".flect")
const GLOBAL_PATH = join(GLOBAL_DIR, "config.json")

const globalCtx: ContextManager<FlectContext> = {
  get configPath() {
    return GLOBAL_PATH
  },
  loadConfig() {
    if (!existsSync(GLOBAL_PATH)) return {}
    try {
      return JSON.parse(readFileSync(GLOBAL_PATH, "utf8")) as FlectConfig
    } catch {
      return {}
    }
  },
  saveConfig(cfg: FlectConfig) {
    mkdirSync(GLOBAL_DIR, { recursive: true })
    writeFileSync(GLOBAL_PATH, JSON.stringify(cfg, null, 2) + "\n")
  },
  getContext() {
    return this.loadConfig().context
  },
  setContext(parts: Partial<FlectContext>) {
    const cfg = this.loadConfig()
    cfg.context = { ...(cfg.context ?? {}), ...parts } as FlectContext
    this.saveConfig(cfg)
  },
  clearContext() {
    const cfg = this.loadConfig()
    delete cfg.context
    this.saveConfig(cfg)
  },
}

const active = () => (existsSync(join(process.cwd(), ".flect", "config.json")) ? localCtx : globalCtx)

export const ctx: ContextManager<FlectContext> = {
  get configPath() {
    return active().configPath
  },
  loadConfig: () => active().loadConfig(),
  saveConfig: (cfg) => active().saveConfig(cfg),
  getContext: () => active().getContext(),
  setContext: (parts) => active().setContext(parts),
  clearContext: () => active().clearContext(),
}

// ─── Plane bases ────────────────────────────────────────────────────────────
// One gateway URL (Caddy/Traefik) fronts the plane and routes by path prefix:
//   <gw>/v1/auth → auth · <gw>/v1/iam → iam · <gw>/v1/org → org
// Set it once with FLECT_URL (or `gatewayUrl` in config) and every base derives
// from it. Per-service overrides (FLECT_AUTH_URL / FLECT_IAM_URL / FLECT_ORG_URL)
// still win, for talking to services directly (e.g. a tsx dev-runner on ports).

function gatewayBase(): string | undefined {
  const cfg = ctx.loadConfig() as Record<string, unknown>
  const gw = process.env["FLECT_URL"] ?? (cfg["gatewayUrl"] as string | undefined)
  return gw ? gw.replace(/\/+$/, "") : undefined
}

function planeBase(cfgKey: string, envKey: string, gatewaySuffix: string, fallback: string): string {
  const cfg = ctx.loadConfig() as Record<string, unknown>
  const explicit = process.env[envKey] ?? (cfg[cfgKey] as string | undefined)
  if (explicit) return explicit.replace(/\/+$/, "")
  const gw = gatewayBase()
  if (gw) return `${gw}${gatewaySuffix}`
  return fallback.replace(/\/+$/, "")
}

/** auth-service origin (no /v1/auth) — the device-flow login endpoint. */
export function getAuthBase(): string {
  return planeBase("authBase", "FLECT_AUTH_URL", "", "https://api.flect.cloud")
}

/** iam-service base — identity + credentials. */
export function getIamBase(): string {
  return planeBase("iamBase", "FLECT_IAM_URL", "/v1/iam", "https://api.flect.cloud")
}

/** org-service base — tenancy (org/ws/proj/env) + membership + PDP. */
export function getOrgBase(): string {
  return planeBase("orgBase", "FLECT_ORG_URL", "/v1/org", "https://api.flect.cloud")
}

// ─── Identity token ─────────────────────────────────────────────────────────

/** Save the identity JWT minted by `login`. */
export function saveIdentityToken(token: string): void {
  const cfg = ctx.loadConfig() as Record<string, unknown>
  cfg["token"] = token
  ctx.saveConfig(cfg as never)
}

/** The identity JWT verified by iam/org. Env override: FLECT_TOKEN. */
export function getIdentityToken(): string | undefined {
  const cfg = ctx.loadConfig() as Record<string, unknown>
  return resolveToken(cfg, { env: "FLECT_TOKEN" })
}

/** Clear the identity token + active plane context (`logout`). */
export function clearIdentity(): void {
  const cfg = ctx.loadConfig() as Record<string, unknown>
  delete cfg["token"]
  delete cfg["context"]
  ctx.saveConfig(cfg as never)
}

/** Active org id from context (set by `use`) — sent as X-Org-Id to org-scoped calls. */
export function getContextOrgId(): string | undefined {
  return ctx.getContext()?.orgId
}

/**
 * The active scope id the broker deploys/resources hang off — the deepest
 * org-service scope set by `flect use` (env → project → workspace → org). The
 * broker treats it as an opaque org-service scope id (tenancy is delegated), so
 * `flect use acme/prod` then `flect db create` lands the resource in that env.
 */
export function getBrokerScope(): string | undefined {
  const c = ctx.getContext()
  return c?.envId ?? c?.projectId ?? c?.workspaceId ?? c?.orgId
}

/** Human path of the active scope, e.g. "acme/prod/api/dev" (for display). */
export function getBrokerScopePath(): string | undefined {
  const c = ctx.getContext()
  if (!c) return undefined
  return [c.org, c.workspace, c.project, c.env].filter(Boolean).join("/") || undefined
}

// ─── HTTP clients ───────────────────────────────────────────────────────────
// Identity JWT (from login), per-service base. Used by the iam/org command
// groups. org-scoped calls carry the active org as X-Org-Id (set by `use`).

export const iamHttp = createApiClient(getIdentityToken, getIamBase)
export const orgHttp = createApiClient(getIdentityToken, getOrgBase, (): Record<string, string> => {
  const orgId = getContextOrgId()
  return orgId ? { "X-Org-Id": orgId } : {}
})

/** Public app origin (for auth returnTo / links). */
export const APP_BASE = (process.env["FLECT_APP_URL"] ?? "https://flect.cloud").replace(/\/+$/, "")
