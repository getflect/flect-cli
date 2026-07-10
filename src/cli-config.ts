/**
 * Persistent CLI config at `~/.flect/config.json`, so `flect` works globally
 * without re-passing `--broker` / `--token` each call. Resolution precedence
 * for every command: explicit flag > environment > config file > default.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface CliConfig {
  /** Broker/API base URL, e.g. https://api-test.flect.cloud. */
  broker?: string
  /** Legacy key from the previous CLI; read as a fallback for `broker`. */
  apiBase?: string
  /** Runtime token (identity JWT after `flect login`, or dev:<tenant>:<scopeId>). */
  token?: string
  /** Active scope id (set by `flect use`), sent as X-Flect-Scope. */
  scope?: string
  /** Auth base for `flect login` (defaults to the broker origin). */
  auth?: string
}

export const CONFIG_DIR = join(homedir(), ".flect")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")

export async function loadCliConfig(): Promise<CliConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as CliConfig
  } catch {
    return {}
  }
}

export async function saveCliConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
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
  const brokerUrl =
    opts.broker ?? process.env["FLECT_BROKER_URL"] ?? file.broker ?? file.apiBase ?? "http://localhost:8787"
  const token = opts.token ?? process.env["FLECT_TOKEN"] ?? file.token
  return { brokerUrl, token }
}
