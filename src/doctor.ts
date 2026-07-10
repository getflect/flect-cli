/**
 * `flect doctor` — end-user diagnosis (RFC-0010 companion). Answers "why isn't
 * this working?" with ok/fail checks and a concrete fix per failure. Only uses
 * what an end user has: the CLI config and the public broker/auth endpoints —
 * no cluster access (operators use ops/flectops.py for that).
 */

import { access } from "node:fs/promises"
import { loadCliConfig, resolveConnection, CONFIG_PATH } from "./cli-config.js"
import { loadFlectToml } from "./config.js"

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

async function head(url: string, timeoutMs = 6000): Promise<number> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: "manual" })
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
  const cfg = await loadCliConfig()
  const hasConfig = await access(CONFIG_PATH).then(() => true, () => false)
  if (hasConfig) line(OK, "config", CONFIG_PATH)
  else warn("config", `no config at ${CONFIG_PATH}`, "flect login  (or flect config set broker <url>)")

  const { brokerUrl, token } = await resolveConnection(opts)
  const authBase = cfg.auth ?? new URL(brokerUrl).origin

  // 2. broker reachable
  const brokerUp = (await head(`${brokerUrl}/healthz`)) === 200
  if (brokerUp) line(OK, "broker", brokerUrl)
  else fail("broker", `${brokerUrl}/healthz unreachable`, "flect config set broker <url>  (is the platform up?)")

  // 3. auth service
  const authUp = (await head(`${authBase}/v1/auth/healthz`)) === 200
  if (authUp) line(OK, "auth", `${authBase}/v1/auth`)
  else warn("auth", `${authBase}/v1/auth/healthz unreachable`, "flect config set auth <url>")

  // 4. token shape
  if (!token) {
    fail("token", "no token configured", "flect login")
  } else if (token.startsWith("dev:")) {
    warn("token", "dev token (no real identity)", "flect login for SSO identity")
  } else {
    const claims = jwtPayload(token)
    if (!claims) fail("token", "not a decodable JWT", "flect login")
    else {
      const exp = typeof claims["exp"] === "number" ? claims["exp"] * 1000 : undefined
      if (exp && exp < Date.now()) fail("token", "expired", "flect login")
      else if (!claims["org_id"]) {
        fail("token", "JWT has no org_id — the broker will reject it", "flect login (if it persists, your account has no organization — contact the operator)")
      } else {
        line(OK, "token", `org ${String(claims["org_id"]).slice(0, 13)}… exp ${exp ? new Date(exp).toISOString().slice(0, 16) : "?"}`)
      }
    }
  }

  // 5. broker accepts the token + scopes
  let scopes: Array<{ id: string; kind: string; slug: string }> = []
  if (token && brokerUp) {
    const res = await fetch(`${brokerUrl}/v1/scopes`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    if (res?.ok) {
      scopes = (await res.json()) as typeof scopes
      line(OK, "api access", `/v1/scopes → ${scopes.length} scope(s)`)
      if (scopes.length === 0) warn("scopes", "tenant has no scopes yet", "flect scope create workspace <name>")
    } else {
      const body = res ? await res.text().catch(() => "") : ""
      fail("api access", `/v1/scopes → ${res?.status ?? "unreachable"} ${body.slice(0, 80)}`, "flect login")
    }
  }

  // 6. active scope
  if (cfg.scope) {
    const known = scopes.some((s) => s.id === cfg.scope)
    if (known || scopes.length === 0) line(OK, "active scope", cfg.scope)
    else warn("active scope", `${cfg.scope} not in your scope tree`, "flect scope list && flect use <scope>")
  } else {
    warn("active scope", "none set — scope-level commands will fail", "flect use <scope>")
  }

  // 7. providers (resource provisioning)
  if (token && brokerUp) {
    const res = await fetch(`${brokerUrl}/v1/providers`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
    if (res?.ok) {
      const providers = (await res.json()) as Array<{ bindingKind: string; status: string }>
      const kinds = new Set(providers.filter((p) => p.status === "active").map((p) => p.bindingKind))
      if (kinds.size) line(OK, "providers", [...kinds].sort().join(", "))
      else warn("providers", "none registered — db/kv/store provisioning will fail", "an operator must register providers for your tenant")
    }
  }

  // 8. project files (only if a flect.toml is present here)
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
