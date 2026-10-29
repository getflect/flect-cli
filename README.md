# @dotlabshq/flect-cli

The command-line interface for [Flect](https://flect.cloud) — deploy apps and
their backing resources (database, KV, object storage) from a `flect.toml`, and
run them locally. Your code only ever calls `createEnv()`; the CLI provisions,
binds, and deploys everything behind it.

## Install

Run it once, no install:

```bash
npx @dotlabshq/flect-cli login
```

Install globally to get the `flect` command:

```bash
npm install -g @dotlabshq/flect-cli
flect --version
```

Or the one-line installer (installs the npm package globally):

```bash
curl -fsSL https://raw.githubusercontent.com/getflect/flect-cli/main/install.sh | sh
```

Requires Node.js 20+.

> Versions up to 0.2.3 were published as `@getflect/cli`. From 0.2.4 the CLI
> ships as `@dotlabshq/flect-cli`; the command is still `flect`. If you have
> the old package, swap it:
> `npm uninstall -g @getflect/cli && npm install -g @dotlabshq/flect-cli`.

## Quick start

```bash
flect login                        # SSO → ~/.flect/config.json
flect use <org>                    # the org your files deploy in
flect db create clave-db           # prints the id to write: id = "res_k7f3a2"
flect deploy                       # flect.toml → its scope
flect deploy -c flect.dev.toml     # another scope is another file
```

A `flect.toml` is **one application in one scope**. Its services are that
application's microservices; databases, KV stores and object stores are
resources created apart and used by id (RFC-0019):

```toml
[app]
name  = "clave"
scope = "platform/clave/production"   # workspace/project/environment; the file decides

[[databases]]
binding = "DB"                         # code calls env.db("DB")
id      = "res_k7f3a2"                 # flect db create; a resource of this scope

[vars]                                 # every service
NODE_ENV = "production"

[services.foldbase]
image = "ghcr.io/dotlabshq/foldbase:0.5.0"
uses  = ["DB"]                         # the only bindings it may resolve

[services.web]
image  = "ghcr.io/dotlabshq/clave-web:0.2.4"
public = true
calls  = ["foldbase"]                  # FOLDBASE_SERVICE_URL; nothing else
```

- A service gets only what it lists: `uses` (the broker refuses any other
  binding), `calls`, `[vars]` plus its own `[services.X.vars]`.
- `flect deploy` checks the whole file against the scope first and changes
  nothing if anything is off: an id that is not a resource of this scope, a
  binding name another application already uses, kept vars the file would
  drop (`--yes` drops them).
- `--scope` is refused for this format: a production file cannot be sent to
  dev by a flag.
- Secrets: the file lists names (`secrets = ["JWT_SECRET"]` on a service);
  `flect secret set <service> <NAME>` reads the value from stdin and keeps it
  for that service in the file's scope. Only the services that list a secret
  get it, and a deploy stops while a listed one is not set. Nothing prints a
  value.
- `flect db list` shows each resource's id and which services use it;
  `flect db delete` is refused while it is bound (`--force` unbinds first).

The old format (`[[apps]]`, resources by `name`) keeps working as before: it
deploys to the active scope (`flect use`), creates resources by name, and
gives every app every var and service.

```typescript
import { createEnv } from "@dotlabshq/flect-sdk"
const db = await createEnv().db("DB")   // an official @libsql/client — no URL, no secret
```

## Local development

```bash
flect dev                          # writes flect.local.json
```

`createEnv()` then resolves bindings against local sqlite / Valkey / MinIO — the
same app code, no broker needed.

## Commands

| Command | What it does |
|---|---|
| `flect login` / `logout` | SSO sign-in; token stored in `~/.flect/config.json` |
| `flect init` | scaffold a `flect.toml` |
| `flect dev` | generate `flect.local.json` for local `createEnv()` |
| `flect deploy [-c file] [--yes]` | check the file against its scope, bind, deploy each service |
| `flect bindings` | list bindings/apps/services declared in `flect.toml` |
| `flect apps` | list deployed apps in the active scope |
| `flect scope create\|list` · `flect use` | manage / switch the active scope |
| `flect db\|kv\|store create\|list\|status\|delete [-c file]` | manage resources in the file's scope (else the active one) |
| `flect secret set\|list\|unset <service> [NAME] [-c file]` | a service's secrets in the file's scope (values from stdin) |
| `flect resolve <binding>` | inspect a binding manifest (secrets redacted) |
| `flect whoami` · `flect ps` | show identity and where you're pointed |
| `flect doctor` | diagnose config / broker / auth / scope / providers |
| `flect config set <broker\|token\|scope\|auth>` | persist CLI config |

Run `flect <command> --help` for options.

## Configuration

Connection settings resolve in order: **flags → environment → `~/.flect/config.json`
→ defaults**.

| Env | Purpose |
|---|---|
| `FLECT_BROKER_URL` | control-plane URL |
| `FLECT_TOKEN` | runtime / identity token |

## Docs

Full documentation, guides, and the `flect.toml` reference:
[flect.cloud/docs](https://flect.cloud). Source and issues:
[github.com/getflect/flect-cli](https://github.com/getflect/flect-cli).

## License

MIT

## Profiles

Every command reads one config file: `~/.flect/config.json`, a project's own
`.flect/config.json` when you are in that project, or a profile.

```bash
FLECT_PROFILE=local flect config set gatewayUrl https://ubuntu.orb.local
FLECT_PROFILE=local flect config set caFile ~/path/to/private-root-ca.pem
FLECT_PROFILE=local flect login
FLECT_PROFILE=local flect apps
```

A profile lives in `~/.flect/profiles/<name>/` and holds its own token,
gateway, active context and, for a gateway under a private CA, `caFile`.
`FLECT_HOME=<dir>` points the CLI at any directory instead. `flect config get`
shows which file is in use.

## Development

```bash
just check   # typecheck, unit tests, build
just e2e     # the built CLI against the local realm, through the dashboard gateway
```

`just e2e` needs the local realm up (auth, iam, org, broker and the dashboard
on `:3300`, see the flect repo's `just up`). It signs in as a fresh user with
the realm's local HS256 secret, makes its own org, deletes it afterwards, and
runs in a temporary HOME, so `~/.flect` is never read or written. Pass another
gateway with `just e2e url=https://…`.
