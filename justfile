# Build the CLI and install it globally as `flect`.
#
# pnpm's real global bin dir isn't on PATH here, but ~/Library/pnpm is, so we
# drop a tiny wrapper there that runs the freshly-built dist. Re-run `just
# install` after changing CLI source.

dist := justfile_directory() + "/dist/index.js"
wrapper := env_var('HOME') + "/Library/pnpm/flect"

build:
    pnpm --filter @getflect/cli build

install: build
    printf '#!/bin/sh\nexec node "%s" "$@"\n' "{{dist}}" > "{{wrapper}}"
    chmod +x "{{wrapper}}"
    @echo "installed: flect → {{dist}}"
    @flect --version

patch: build
    npm version patch --no-git-tag-version

minor: build
    npm version minor --no-git-tag-version

publish: build
    npm publish --access public

release-patch:
    just patch
    just publish

release-minor:
    just minor
    just publish
