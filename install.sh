#!/bin/sh
# Flect CLI installer — installs @getflect/cli globally via npm.
#
#   curl -fsSL https://raw.githubusercontent.com/getflect/flect-cli/main/install.sh | sh
#
# Honors $FLECT_CLI_VERSION to pin a version (default: latest).
set -eu

PKG="@getflect/cli"
VERSION="${FLECT_CLI_VERSION:-latest}"

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
err()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js 20+ is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || err "npm is required (ships with Node.js)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || err "Node.js 20+ required, found $(node -v)"

info "Installing ${PKG}@${VERSION}…"
npm install -g "${PKG}@${VERSION}"

if command -v flect >/dev/null 2>&1; then
  info "Installed: $(flect --version) → run 'flect login' to get started"
else
  info "Installed. If 'flect' isn't found, add your npm global bin to PATH:"
  printf '    export PATH="%s:$PATH"\n' "$(npm prefix -g)/bin"
fi
