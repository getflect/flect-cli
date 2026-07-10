/** Templates for `flect init`. */

export function flectTomlTemplate(name: string): string {
  return `name    = "${name}"
runtime = "node"
port    = 3000

# Where this project lives in the scope tree (workspace/project/environment).
# \`flect deploy\` resolves this path and CREATES any missing scope, so the
# manifest alone describes where the project deploys.
scope   = "${name}/main/prod"

# Deployment region — only "eu" exists today (the default); more regions later.
# region = "eu"

# The container to deploy. Build + push your image, then uncomment and run
# \`flect deploy\`. Omit this block to only provision resources (flect dev).
# [[apps]]
# name   = "${name}"
# image  = "ghcr.io/you/${name}:0.1.0"
# port   = 3000
# public = true            # owns the domain → https://${name}-<shortid>.up.flect.run

[[databases]]
binding = "DB"
name    = "${name}-db"

[[kv]]
binding = "CACHE"
name    = "${name}-cache"

# [[stores]]
# binding = "FILES"
# name    = "${name}-uploads"
`
}

export const GITIGNORE_LINES = ["", "# Flect local dev (may contain resolved connections)", "flect.local.json", ".flect/", ""]

/**
 * Redact secret-bearing fields from a manifest connection for display. Matches
 * actual credential fields (authToken, password, secretAccessKey, accessKeyId,
 * sessionToken) without over-redacting benign ones like `keyPrefix`.
 */
export function redactConnection(connection: Record<string, unknown>): Record<string, unknown> {
  const SECRET = /(auth.?token|password|secret|access.?key|session.?token)/i
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(connection)) {
    out[k] = SECRET.test(k) && typeof v === "string" && v.length > 0 ? "***redacted***" : v
  }
  return out
}
