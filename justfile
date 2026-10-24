# Build the CLI and install it globally as `flect`.
#
# pnpm's real global bin dir isn't on PATH here, but ~/Library/pnpm is, so we
# drop a tiny wrapper there that runs the freshly-built dist. Re-run `just
# install` after changing CLI source.

dist := justfile_directory() + "/dist/index.js"
wrapper := env_var('HOME') + "/Library/pnpm/flect"

build:
    pnpm build

install: build
    printf '#!/bin/sh\nexec node "%s" "$@"\n' "{{dist}}" > "{{wrapper}}"
    chmod +x "{{wrapper}}"
    @echo "installed: flect → {{dist}}"
    @flect --version

patch:
    npm version patch --no-git-tag-version

minor:
    npm version minor --no-git-tag-version

# Typecheck, unit tests, build. `publish` runs this first.
check:
    pnpm typecheck
    pnpm test
    pnpm build

# The built CLI against a running realm (default: the local one behind the
# dashboard gateway). Signs in as a fresh user with the realm's local HS256
# secret, makes its own org, deletes it after. Never touches ~/.flect.
e2e url="http://localhost:3300" secret_file=(justfile_directory() + "/../baseworks-ts/projects/auth-service/.env.local"):
    pnpm build
    FLECT_E2E_URL="{{url}}" FLECT_E2E_JWT_SECRET="$(grep '^JWT_SECRET=' '{{secret_file}}' | cut -d= -f2-)" pnpm exec vitest run src/e2e.test.ts

# Refuse a version npm already has, before building anything. The repo once
# said 0.2.1 while npm had 0.2.3.
unpublished:
    #!/usr/bin/env bash
    set -euo pipefail
    v=$(node -p "require('./package.json').version")
    if npm view "@dotlabshq/flect-cli@$v" version --prefer-online 2>/dev/null | grep -q .; then
      echo "✗ @dotlabshq/flect-cli@$v is already on npm (latest: $(npm view @dotlabshq/flect-cli version --prefer-online 2>/dev/null || echo none)). Bump first: just patch" >&2
      exit 1
    fi
    echo "✓ @dotlabshq/flect-cli@$v is not on npm yet"

publish: unpublished check
    npm publish --access public

release-patch:
    just patch
    just publish

release-minor:
    just minor
    just publish
