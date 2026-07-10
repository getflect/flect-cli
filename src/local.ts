/**
 * Generate `flect.local.json` from `flect.toml` (RFC-0009 / RFC-0016). This is
 * what `flect dev` produces so `createEnv()` resolves bindings locally with no
 * broker. Connections use `${VAR}` placeholders — secrets come from the
 * environment at runtime, never written into the file or the app code.
 */

import type { BindingDecl, FlectProject } from "./config.js"

interface LocalBindingSpec {
  kind: string
  provider: string
  connection: Record<string, unknown>
}

export interface LocalConfig {
  _generatedBy: string
  bindings: Record<string, LocalBindingSpec>
}

const upper = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()

function connectionFor(app: string, b: BindingDecl): LocalBindingSpec {
  switch (b.kind) {
    case "database":
      return {
        kind: "database",
        provider: "libsql",
        connection: { url: `\${${upper(b.name)}_URL:-:memory:}` },
      }
    case "kv":
      return {
        kind: "kv",
        provider: "redis",
        connection: {
          url: "${VALKEY_URL:-redis://localhost:6379}",
          keyPrefix: `${app}-${b.resource}:`,
        },
      }
    case "storage":
      return {
        kind: "storage",
        provider: "s3",
        connection: {
          endpoint: "${S3_ENDPOINT:-http://localhost:9000}",
          region: "${S3_REGION:-us-east-1}",
          accessKeyId: "${S3_ACCESS_KEY_ID}",
          secretAccessKey: "${S3_SECRET_ACCESS_KEY}",
          bucket: `\${${upper(b.name)}_BUCKET:-${b.resource}}`,
          forcePathStyle: true,
        },
      }
  }
}

/** Build the local binding map for a project. */
export function generateLocalConfig(project: FlectProject): LocalConfig {
  const bindings: Record<string, LocalBindingSpec> = {}
  for (const b of project.bindings) {
    bindings[b.name] = connectionFor(project.name, b)
  }
  return {
    _generatedBy: "flect dev — local binding map; secrets come from ${ENV}, never this file",
    bindings,
  }
}
