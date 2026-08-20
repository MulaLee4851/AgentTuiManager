#!/bin/bash

set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

PROXY_URL=""
SKIP_INSTALL=0

usage() {
  cat <<'EOF'
Usage:
  bash build-mac.command [--proxy URL] [--skip-install]

Options:
  --proxy URL       Use an HTTP proxy for npm and Electron downloads.
  --skip-install    Reuse the current Mac node_modules instead of npm ci.
  -h, --help        Show this help.

Examples:
  bash build-mac.command
  bash build-mac.command --proxy http://192.168.1.10:7897
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --proxy)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "Error: --proxy requires a URL." >&2
        exit 2
      fi
      PROXY_URL="$2"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Error: this script must run on macOS." >&2
  exit 1
fi

if [ ! -f package.json ] || ! grep -q '"name": "agent-tui-manager"' package.json; then
  echo "Error: run this script from the extracted AgentTuiManager source package." >&2
  exit 1
fi

MAC_VERSION="$(sw_vers -productVersion)"
MAC_ARCH="$(uname -m)"
case "$MAC_ARCH" in
  arm64) BUILDER_ARCH="arm64" ;;
  x86_64) BUILDER_ARCH="x64" ;;
  *)
    echo "Error: unsupported Mac architecture: $MAC_ARCH" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Error: Node.js and npm are required." >&2
  echo "Install Node.js 20 or 22 LTS, then run this script again." >&2
  echo "With Homebrew: brew install node@20" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
NPM_VERSION="$(npm --version)"
NPM_MAJOR="${NPM_VERSION%%.*}"
if [ "$NODE_MAJOR" -ne 20 ] && [ "$NODE_MAJOR" -ne 22 ] && [ "$NODE_MAJOR" -ne 24 ]; then
  echo "Error: Node.js 20, 22 or 24 is required for this build. Current: $(node --version)" >&2
  echo "Use an LTS release when possible: nvm install 22 && nvm use 22" >&2
  exit 1
fi
if [ -n "$PROXY_URL" ]; then
  export HTTP_PROXY="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL"
  export npm_config_proxy="$PROXY_URL"
  export npm_config_https_proxy="$PROXY_URL"
fi
# Electron downloads are routed through the configured proxy/mirror too.
export ELECTRON_GET_USE_PROXY="${ELECTRON_GET_USE_PROXY:-1}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

NPM_RUN=(npm)
NPM_COMPAT_DIR=""
cleanup() {
  if [ -n "$NPM_COMPAT_DIR" ] && [ -d "$NPM_COMPAT_DIR" ]; then
    rm -rf "$NPM_COMPAT_DIR"
  fi
}
trap cleanup EXIT
if [ "$NPM_MAJOR" -ge 11 ]; then
  echo "npm $NPM_VERSION has a known install exit-handler failure here; loading temporary npm 10.9.2..."
  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is required to load the temporary npm 10 toolchain." >&2
    exit 1
  fi
  NPM_COMPAT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-tui-npm.XXXXXX")"
  if ! curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
    https://registry.npmjs.org/npm/-/npm-10.9.2.tgz \
    | tar -xz -C "$NPM_COMPAT_DIR" --strip-components=1; then
    echo "Error: unable to download temporary npm 10.9.2." >&2
    echo "Check network/proxy, then retry with --proxy http://HOST:7897." >&2
    exit 1
  fi
  NPM_RUN=(node "$NPM_COMPAT_DIR/bin/npm-cli.js")
fi

# Test builds are unsigned by default. Set CSC_IDENTITY_AUTO_DISCOVERY=true
# before running this script if a valid Apple signing identity is installed.
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

echo "Agent TUI Manager macOS packaging"
echo "  macOS:       $MAC_VERSION"
echo "  Architecture: $MAC_ARCH ($BUILDER_ARCH)"
echo "  Node.js:      $(node --version)"
echo "  npm:          $NPM_VERSION"
if [ -n "$PROXY_URL" ]; then
  echo "  Proxy:        $PROXY_URL"
fi
echo

if [ "$SKIP_INSTALL" -eq 0 ]; then
  echo "[1/3] Installing clean macOS dependencies..."
  if ! "${NPM_RUN[@]}" ci --no-audit --no-fund --no-progress --fetch-retries=3 --fetch-timeout=120000 --loglevel=info; then
    echo
    echo "Warning: npm ci failed. Retrying with npm install after clearing only node_modules..." >&2
    rm -rf "$PROJECT_DIR/node_modules"
    "${NPM_RUN[@]}" install --no-audit --no-fund --no-progress --fetch-retries=3 --fetch-timeout=120000 --loglevel=info
  fi
else
  echo "[1/3] Reusing current dependencies (--skip-install)..."
  if [ ! -d node_modules ]; then
    echo "Error: node_modules does not exist; remove --skip-install." >&2
    exit 1
  fi
fi

# Preserve node-pty's macOS helper executable bit in the packaged app.
for helper in node_modules/node-pty/build/Release/spawn-helper node_modules/node-pty/prebuilds/darwin-*/spawn-helper; do
  if [ -f "$helper" ]; then
    chmod 755 "$helper"
  fi
done

echo "[2/3] Building the application..."
"${NPM_RUN[@]}" run build

echo "[3/3] Creating macOS DMG and ZIP..."
node node_modules/electron-builder/out/cli/cli.js --mac dmg zip "--$BUILDER_ARCH"

echo
echo "Build completed. Artifacts:"
for artifact in release/*.dmg release/*.zip; do [ -f "$artifact" ] && echo "  $artifact"; done
echo
echo "These artifacts are unsigned unless Apple signing credentials were configured."
echo "For local testing, macOS may require right-clicking the app and choosing Open."
