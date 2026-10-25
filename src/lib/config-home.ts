/**
 * Where the CLI keeps its config (token, gateway, active context): one rule,
 * used by every command, so the identity commands and the broker commands can
 * never read two different files.
 *
 *   1. FLECT_HOME=<dir>        that directory
 *   2. FLECT_PROFILE=<name>    ~/.flect/profiles/<name>
 *   3. a project's own .flect/config.json, in the working directory, when the
 *      working directory is not the home directory (there, ./.flect IS the
 *      global config and must not be mistaken for a project's)
 *   4. ~/.flect
 *
 * A profile is a whole config: its own token, its own gateway (`flect config
 * set gatewayUrl …`) and, for a gateway under a private CA, its own `caFile`.
 * `FLECT_PROFILE=local flect login` signs in to that profile and nothing else.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import * as tls from "node:tls"

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i

export function globalDir(): string {
  return join(homedir(), ".flect")
}

/** The active profile's name, when one is selected. */
export function profileName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = env["FLECT_PROFILE"]?.trim()
  return p ? p : undefined
}

export function configDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const home = env["FLECT_HOME"]?.trim()
  if (home) return resolve(home)

  const profile = profileName(env)
  if (profile) {
    if (!PROFILE_NAME.test(profile)) {
      throw new Error(`FLECT_PROFILE "${profile}" is not a profile name (letters, digits, - and _)`)
    }
    return join(globalDir(), "profiles", profile)
  }

  const local = resolve(cwd, ".flect")
  if (local !== globalDir() && existsSync(join(local, "config.json"))) return local

  return globalDir()
}

export function configPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return join(configDir(env, cwd), "config.json")
}

/**
 * Trust the active config's `caFile` (a PEM) for every HTTPS call this process
 * makes, on top of the public roots. NODE_EXTRA_CA_CERTS does the same but
 * has to be set before Node starts; a profile carries it instead.
 */
export function trustConfiguredCa(): void {
  let caFile: string | undefined
  try {
    caFile = (JSON.parse(readFileSync(configPath(), "utf8")) as { caFile?: string }).caFile
  } catch {
    return // no config yet
  }
  if (!caFile) return
  const set = (tls as { setDefaultCACertificates?: (certs: string[]) => void }).setDefaultCACertificates
  const get = (tls as { getCACertificates?: (type?: string) => string[] }).getCACertificates
  if (!set || !get) {
    console.error(`warning: caFile is set but this Node cannot load it at runtime; set NODE_EXTRA_CA_CERTS=${caFile}`)
    return
  }
  try {
    set([...get("default"), readFileSync(caFile, "utf8")])
  } catch (err) {
    console.error(`warning: caFile ${caFile} not loaded: ${err instanceof Error ? err.message : String(err)}`)
  }
}
