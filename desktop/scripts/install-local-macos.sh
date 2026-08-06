#!/usr/bin/env bash
set -euo pipefail

# One-click: build the desktop app from the CURRENT source tree and install it
# into /Applications. macOS only, unsigned, `--dir` mode (skips dmg/zip — the
# fastest path when you just want the freshly-built app on your own machine).
#
# Usage:
#   from desktop/     ->  bun run install:local
#   from repo root    ->  bun run desktop:install
#   directly          ->  bash desktop/scripts/install-local-macos.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

APP_NAME="Claude Code Haha.app"
EXECUTABLE="Claude Code Haha"
INSTALL_DIR="/Applications"
INSTALLED_APP="$INSTALL_DIR/$APP_NAME"

# electron-builder writes --dir output to mac-<arch> (mac-arm64 on Apple Silicon,
# mac on Intel). Detect the host arch so we look in the right place.
HOST_ARCH="$(uname -m)"
if [ "$HOST_ARCH" = "arm64" ]; then
  ARCH_DIR="mac-arm64"
  EB_ARCH="arm64"
else
  ARCH_DIR="mac"
  EB_ARCH="x64"
fi
BUILT_APP="build-artifacts/electron/$ARCH_DIR/$APP_NAME"

echo "==> [1/3] Building + packaging desktop app ($EB_ARCH, --dir, unsigned)…"
# CSC_IDENTITY_AUTO_DISCOVERY=false: don't hunt for a signing cert (local build).
# ARCH: consumed by build:sidecars so the bundled binaries match the host.
CSC_IDENTITY_AUTO_DISCOVERY=false ARCH="$EB_ARCH" bun run electron:package:dir

if [ ! -d "$BUILT_APP" ]; then
  echo "ERROR: expected build output not found: $BUILT_APP" >&2
  exit 1
fi

echo "==> [2/3] Installing into $INSTALL_DIR (replacing existing copy)…"
# Quit a running instance so we can swap the bundle cleanly.
osascript -e "quit app \"$EXECUTABLE\"" >/dev/null 2>&1 || true
rm -rf "$INSTALLED_APP"
ditto "$BUILT_APP" "$INSTALLED_APP"
# Locally-built bundles carry no quarantine flag, but strip it defensively so
# Gatekeeper never blocks the launch.
xattr -dr com.apple.quarantine "$INSTALLED_APP" 2>/dev/null || true

echo "==> [3/3] Verifying…"
if [ ! -x "$INSTALLED_APP/Contents/MacOS/$EXECUTABLE" ]; then
  echo "ERROR: installed app is missing its executable" >&2
  exit 1
fi
echo "OK  installed: $INSTALLED_APP"
du -sh "$INSTALLED_APP" 2>/dev/null || true

echo ""
echo "Done. Launch it with:  open -a \"$EXECUTABLE\"   (or from Launchpad / Spotlight)"
