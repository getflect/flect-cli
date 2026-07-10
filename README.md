# @getflect/cli

The command-line interface for [Flect](https://flect.cloud) — deploy apps and
their backing resources (database, KV, object storage) from a `flect.toml`, and
run them locally. Your code only ever calls `createEnv()`; the CLI provisions,
binds, and deploys everything behind it.

## Install

Run it once, no install:

```bash
npx @getflect/cli login
```

Install globally to get the `flect` command:

```bash
npm install -g @getflect/cli
flect --version
```

Or the one-line installer (installs the npm package globally):

```bash
curl -fsSL https://raw.githubusercontent.com/getflect/flect-cli/main/install.sh | sh
```

Requires Node.js 20+.

## Quick start

```bash
flect login                        # SSO → ~/.flect/config.json
flect init                         # scaffold flect.toml (includes a scope path)
flect deploy                       # create the scope, provision resources, bind, deploy
```

`flect deploy` resolves the `scope = "workspace/project/environment"` in your
`flect.toml` and **creates any missing scope**, provisions every resource the
manifest names, binds them, and rolls out your app behind TLS. Your container
receives only `FLECT_TOKEN` + `FLECT_BROKER_URL` — no connection strings.

```toml
name  = "myapp"
port  = 3000
scope = "myapp/main/prod"          # deploy creates missing scopes

[[apps]]
name   = "myapp"
image  = "ghcr.io/you/myapp:0.1.0"
port   = 3000
public = true

[[databases]]
binding = "DB"                     # code calls env.db("DB")
name    = "myapp-db"
```

```typescript
import { createEnv } from "@getflect/sdk"
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
| `flect deploy` | create scope, provision, bind, deploy |
| `flect bindings` | list bindings/apps/services declared in `flect.toml` |
| `flect apps` | list deployed apps in the active scope |
| `flect scope create\|list` · `flect use` | manage / switch the active scope |
| `flect db\|kv\|store create\|list\|status\|delete` | manage resources directly |
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
