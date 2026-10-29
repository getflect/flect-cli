/** Templates for `flect init`. */

/**
 * A services-format flect.toml (RFC-0019): one application in one scope.
 * `scope` is the active context below the org, when there is one.
 */
export function flectTomlTemplate(name: string, scope?: string): string {
  return `# One application in one scope. Another environment is another file
# (flect.dev.toml), deployed with \`flect deploy -c flect.dev.toml\`.
# Reference: https://docs.flect.cloud/platform/flect-toml/

[app]
name  = "${name}"
scope = "${scope ?? "<workspace>/<project>/<environment>"}"

# Resources are created apart and used by id:
#   flect db create ${name}-db      → prints id = "res_…" for this entry
[[databases]]
binding = "DB"                  # code: env.db("DB")
id      = "res_??????"

# [[kv]]
# binding = "CACHE"
# id      = "res_??????"        # flect kv create ${name}-cache

# [vars]                        # every service
# LOG_LEVEL = "info"

[services.web]
image  = "ghcr.io/you/${name}:0.1.0"   # build and push it first (linux/amd64)
port   = 3000
public = true                   # https://${name}-web-<shortid>.up.flect.run
uses   = ["DB"]                 # the only bindings this service may resolve
# calls   = ["api"]             # other services whose address it gets (API_SERVICE_URL)
# secrets = ["API_KEY"]         # values: flect secret set web API_KEY
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
