/**
 * `flect doctor` — end-user diagnosis (RFC-0010 companion). Answers "why isn't
 * this working?" with ok/fail checks and a concrete fix per failure. Only uses
 * what an end user has: the CLI config, the identity/tenancy plane (auth · iam ·
 * org-service), and the public broker — no cluster access.
 *
 * Tenancy is delegated to org-service: the identity JWT need not carry org_id,
 * and the active org/scope live in the CLI context (`flect use`), sent to the
 * broker as `X-Org-Id` / `X-Flect-Scope`. The checks reflect that model.
 */

import { access } from "node:fs/promises"
import { loadCliConfig, resolveConnection, CONFIG_PATH } from "./cli-config.js"
import { loadFlectToml } from "./config.js"
import {
  getAuthBase,
  getIamBase,
  getOrgBase,
  getIdentityToken,
  getContextOrgId,
  getBrokerScope,
  getBrokerScopePath,
} from "./lib/context.js"

const OK = "\x1b[32m✓\x1b[0m"
const BAD = "\x1b[31m✗\x1b[0m"
const WARN = "\x1b[33m!\x1b[0m"

interface Report {
  fails: number
  warns: number
}

function line(mark: string, name: string, detail: string, fix?: string): void {
  console.log(`  ${mark} ${name.padEnd(16)} ${detail}`)
  if (fix) console.log(`      → ${fix}`)
}

async function head(url: string, headers: Record<string, string> = {}, timeoutMs = 6000): Promise<number> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "manual", headers })
    return res.status
  } catch {
    return 0
  } finally {
    clearTimeout(t)
  }
}

/** Decode a JWT payload without verifying (diagnosis only). */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const seg = token.split(".")[1]
  if (!seg) return undefined
  try {
    return JSON.parse(Buffer.from(seg, "base64url").toString()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export async function runDoctor(opts: { broker?: string; token?: string }): Promise<number> {
  const r: Report = { fails: 0, warns: 0 }
  const fail = (name: string, detail: string, fix: string) => {
    r.fails++
    line(BAD, name, detail, fix)
  }
  const warn = (name: string, detail: string, fix?: string) => {
    r.warns++
    line(WARN, name, detail, fix)
  }

  // 1. config
  await loadCliConfig()
  const hasConfig = await access(CONFIG_PATH).then(() => true, () => false)
  if (hasConfig) line(OK, "config", CONFIG_PATH)
  else warn("config", `no config at ${CONFIG_PATH}`, "flect login")

  const { brokerUrl } = await resolveConnection(opts)
  const token = opts.token ?? getIdentityToken()

  // 2. identity/tenancy plane (auth · iam · org-service)
  const planes: Array<[string, string]> = [
    ["auth", `${getAuthBase()}/v1/auth/healthz`],
    ["iam", `${getIamBase()}/healthz`],
    ["org-service", `${getOrgBase()}/healthz`],
  ]
  for (const [name, url] of planes) {
    ;(await head(url)) === 200
      ? line(OK, name, url.replace(/\/healthz$/, ""))
      : warn(name, `${url} unreachable`, "set FLECT_URL (gateway) or FLECT_{AUTH,IAM,ORG}_URL")
  }

  // 3. broker reachable
  const brokerUp = (await head(`${brokerUrl}/healthz`)) === 200
  if (brokerUp) line(OK, "broker", brokerUrl)
  else fail("broker", `${brokerUrl}/healthz unreachable`, "flect config set broker <url>  (is the platform up?)")

  // 4. token shape — identity-only JWT (no org_id needed; tenancy via org-service)
  if (!token) {
    fail("token", "no token configured", "flect login")
  } else if (token.startsWith("dev:")) {
    warn("token", "dev token (no real identity)", "flect login for SSO identity")
  } else {
    const claims = jwtPayload(token)
    const exp = typeof claims?.["exp"] === "number" ? (claims!["exp"] as number) * 1000 : undefined
    if (!claims || !claims["sub"]) fail("token", "not a decodable identity JWT", "flect login")
    else if (exp && exp < Date.now()) fail("token", "expired", "flect login")
    else line(OK, "token", `sub ${String(claims["sub"]).slice(0, 13)}… exp ${exp ? new Date(exp).toISOString().slice(0, 16) : "?"}`)
  }

  // 5. active context (org + scope), set by `flect use`
  const orgId = getContextOrgId()
  const scopeId = getBrokerScope()
  if (orgId) line(OK, "active org", `${getBrokerScopePath() ?? orgId} (${orgId.length > 13 ? `${orgId.slice(0, 13)}…` : orgId})`)
  else warn("active org", "no org context — tenant-scoped commands will fail", "flect use <org[/ws/proj/env]>")
  if (!scopeId) warn("active scope", "none set — deploy/db/kv target no scope", "flect use <org/ws/proj/env>")

  // 6. broker accepts the token + tenant (identity JWT + X-Org-Id → the PDP-gated API)
  if (token && brokerUp && orgId) {
    const res = await fetch(`${brokerUrl}/v1/providers`, {
      headers: { Authorization: `Bearer ${token}`, "X-Org-Id": orgId, ...(scopeId ? { "X-Flect-Scope": scopeId } : {}) },
    }).catch(() => undefined)
    if (res?.ok) {
      const providers = (await res.json()) as Array<{ bindingKind: string; status: string }>
      const kinds = new Set(providers.filter((p) => p.status === "active").map((p) => p.bindingKind))
      line(OK, "api access", `broker accepts your identity + org (X-Org-Id)`)
      if (kinds.size) line(OK, "providers", [...kinds].sort().join(", "))
      else warn("providers", "none registered — db/kv/store provisioning will fail", "an operator must register providers for your tenant")
    } else {
      const body = res ? await res.text().catch(() => "") : ""
      fail("api access", `/v1/providers → ${res?.status ?? "unreachable"} ${body.slice(0, 80)}`, "flect login / flect use")
    }
  }

  // 7. project files (only if a flect.toml is present here)
  try {
    await access("flect.toml")
    try {
      const project = await loadFlectToml()
      line(OK, "flect.toml", `${project.name} — ${project.bindings.length} binding(s), ${project.apps.length} app(s)`)
    } catch (err) {
      fail("flect.toml", err instanceof Error ? err.message : String(err), "fix the file (see flect.cloud docs → flect.toml reference)")
    }
    const hasLocal = await access("flect.local.json").then(() => true, () => false)
    if (hasLocal) line(OK, "local dev", "flect.local.json present (createEnv() works offline)")
  } catch {
    /* no flect.toml here — not a project directory, skip silently */
  }

  console.log("")
  if (r.fails) console.log(`${r.fails} problem(s), ${r.warns} warning(s)`)
  else console.log(r.warns ? `healthy — ${r.warns} warning(s)` : "all checks passed")
  return r.fails ? 1 : 0
}
