/**
 * Persistent CLI config at `~/.flect/config.json`, so `flect` works globally
 * without re-passing `--broker` / `--token` each call. Resolution precedence
 * for every command: explicit flag > environment > config file > default.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { configDir, configPath } from "./lib/config-home.js"

export interface CliConfig {
  /** Broker/API base URL, e.g. https://api-test.flect.cloud. */
  broker?: string
  /**
   * Single gateway origin that fronts the whole plane (auth/iam/org at
   * /v1/*, broker at /). Set it once and both the identity-plane bases and the
   * broker URL derive from it. See lib/context.ts `gatewayBase`.
   */
  gatewayUrl?: string
  /** Legacy key from the previous CLI; read as a fallback for `broker`. */
  apiBase?: string
  /** Runtime token (identity JWT after `flect login`, or dev:<tenant>:<scopeId>). */
  token?: string
  /** Active scope id (set by `flect use`), sent as X-Flect-Scope. */
  scope?: string
  /** Auth base for `flect login` (defaults to the broker origin). */
  auth?: string
  /** A PEM the CLI trusts beyond the public roots: a gateway under a private CA. */
  caFile?: string
}

/** The config file every command reads (see lib/config-home.ts). */
export { configPath } from "./lib/config-home.js"

export async function loadCliConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as CliConfig
  } catch {
    return {}
  }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true })
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

/** Mask a token for display: keep the tenant/scope shape, hide the rest. */
export function maskToken(token: string | undefined): string {
  if (!token) return "(unset)"
  if (token.startsWith("dev:")) return token // dev tokens are not yet secrets
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}…${token.slice(-2)}`
}

/**
 * Resolve broker URL + token for a command. Precedence: flag > env > config
 * file > default. Returns `token: undefined` if none is set (caller decides if
 * it is required — read-only inspection may not need one once auth lands).
 */
export async function resolveConnection(opts: {
  broker?: string
  token?: string
}): Promise<{ brokerUrl: string; token?: string }> {
  const file = await loadCliConfig()
  // The gateway origin fronts the broker at `/`, so a single `gatewayUrl` (or
  // FLECT_URL) drives both the identity plane and the broker — no need to set
  // `broker` separately against prod. Explicit broker still wins.
  const brokerUrl = (
    opts.broker ??
    process.env["FLECT_BROKER_URL"] ??
    process.env["FLECT_URL"] ??
    file.broker ??
    file.apiBase ??
    file.gatewayUrl ??
    "http://localhost:8787"
  ).replace(/\/+$/, "")
  const token = opts.token ?? process.env["FLECT_TOKEN"] ?? file.token
  return { brokerUrl, token }
}
