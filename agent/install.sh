#!/bin/sh
# KeepWatch agent installer for Linux systemd hosts (amd64, arm64, armv7).
#
#   curl -fsSL https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/install.sh | sh -s -- --server URL --token TOKEN
#
# Run it as root (the default on Proxmox). It never calls sudo itself.
set -eu

REPO="tfourj/KeepWatch"
# Empty means the newest agent-vX.Y.Z release on GitHub.
RELEASE_BASE=""
SCRIPT_URL="https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/install.sh"
BIN_PATH="/usr/local/bin/keepwatch-agent"
STATE_DIR="/var/lib/keepwatch-agent"

SERVER=""
TOKEN=""
ALLOW_HTTP=""
LOCAL_BINARY=""
ALLOW_SCRIPTS=""

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage: install.sh [--server URL] [--token TOKEN] [--release-base URL] [--allow-http] [--binary PATH]
                  [--allow-custom-scripts]

Installs or upgrades the KeepWatch agent and pairs it with your KeepWatch server.
Without --token on an already paired machine, only the binary is upgraded.
--allow-custom-scripts lets health checks run root-owned scripts from /etc/keepwatch/scripts.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --release-base) RELEASE_BASE="${2:-}"; shift 2 ;;
    --allow-http) ALLOW_HTTP="1"; shift ;;
    --binary) LOCAL_BINARY="${2:-}"; shift 2 ;;
    --allow-custom-scripts) ALLOW_SCRIPTS="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  say "The KeepWatch agent installer needs root to install a system service."
  say ""
  say "Rerun the same command with sudo, for example:"
  say "  curl -fsSL $SCRIPT_URL | sudo sh -s -- --server <url> --token <token>"
  say ""
  say "If sudo is not installed, log in as root first (su -) and run the command again."
  exit 1
fi

[ "$(uname -s)" = "Linux" ] || fail "only Linux is supported"
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail "systemd is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required (coreutils)"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  probe() { curl -fsS -o /dev/null --max-time 10 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  probe() { wget -q -O /dev/null -T 10 "$1"; }
else
  fail "curl or wget is required"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  armv7l|armv7) ARCH="armv7" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

PAIRED=""
[ -f "$STATE_DIR/state.json" ] && PAIRED="1"

if [ -z "$TOKEN" ] && [ -z "$PAIRED" ]; then
  [ -r /dev/tty ] || fail "--server and --token are required"
  if [ -z "$SERVER" ]; then
    printf 'KeepWatch URL (for example https://keepwatch.example.com): ' >/dev/tty
    read -r SERVER </dev/tty
  fi
  printf 'Enrollment token: ' >/dev/tty
  read -r TOKEN </dev/tty
fi

if [ -n "$TOKEN" ]; then
  [ -n "$SERVER" ] || fail "--server is required with --token"
  SERVER="${SERVER%/}"
  case "$SERVER" in
    https://*) ;;
    http://*) [ -n "$ALLOW_HTTP" ] || fail "server URL must use https (add --allow-http only on a trusted LAN)" ;;
    *) fail "server URL must start with https://" ;;
  esac
  say "Checking KeepWatch at $SERVER ..."
  probe "$SERVER/api/health" || fail "cannot reach $SERVER/api/health from this machine"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
ASSET="keepwatch-agent-linux-$ARCH"

if [ -n "$LOCAL_BINARY" ]; then
  say "Using local binary $LOCAL_BINARY"
  cp "$LOCAL_BINARY" "$TMP/$ASSET"
else
  # A GitHub releases page means the newest agent-vX.Y.Z release there, anything else is a fixed directory.
  DOWNLOAD_BASE=""
  case "$RELEASE_BASE" in
    "") ;;
    https://github.com/*/*/releases|https://github.com/*/*/releases/latest/download)
      REPO="$(printf '%s' "$RELEASE_BASE" | sed 's#^https://github.com/\([^/]*/[^/]*\)/releases.*#\1#')" ;;
    *) DOWNLOAD_BASE="$RELEASE_BASE" ;;
  esac
  if [ -z "$DOWNLOAD_BASE" ]; then
    fetch "https://api.github.com/repos/$REPO/releases?per_page=100" "$TMP/releases.json" \
      || fail "could not list releases of $REPO"
    VERSION="$(tr ',' '\n' < "$TMP/releases.json" \
      | sed -n 's/.*"tag_name": *"agent-v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
      | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
    [ -n "$VERSION" ] || fail "no agent release found in $REPO"
    DOWNLOAD_BASE="https://github.com/$REPO/releases/download/agent-v$VERSION"
  fi
  say "Downloading $ASSET ..."
  fetch "$DOWNLOAD_BASE/$ASSET" "$TMP/$ASSET" || fail "download failed: $DOWNLOAD_BASE/$ASSET"
  fetch "$DOWNLOAD_BASE/$ASSET.sha256" "$TMP/$ASSET.sha256" || fail "checksum download failed"
  (cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null) || fail "checksum verification failed"
  say "Checksum verified"
fi

chmod 0755 "$TMP/$ASSET"
"$TMP/$ASSET" version >/dev/null || fail "downloaded binary does not run on this machine"

if systemctl is-active --quiet keepwatch-agent 2>/dev/null; then
  systemctl stop keepwatch-agent
fi
install -m 0755 "$TMP/$ASSET" "$BIN_PATH.new"
mv -f "$BIN_PATH.new" "$BIN_PATH"
say "Installed $("$BIN_PATH" version)"

if [ -n "$TOKEN" ]; then
  # Without --release-base the agent updates from the newest agent-vX.Y.Z release on GitHub.
  set -- enroll --server "$SERVER" --token "$TOKEN"
  [ -z "$RELEASE_BASE" ] || set -- "$@" --release-base "$RELEASE_BASE"
  [ -z "$ALLOW_HTTP" ] || set -- "$@" --allow-http
  "$BIN_PATH" "$@"
fi

# Custom check scripts are opt-in on the node itself. The server cannot turn them on.
if [ -n "$ALLOW_SCRIPTS" ]; then
  install -d -o root -g root -m 0755 /etc/keepwatch /etc/keepwatch/scripts
  install -o root -g root -m 0644 /dev/null /etc/keepwatch/allow-custom-scripts
  say "Custom check scripts allowed from /etc/keepwatch/scripts"
fi

# The agent carries its own service file, so updates can refresh it later.
"$BIN_PATH" install-unit >/dev/null || fail "could not write the systemd service file"

systemctl enable keepwatch-agent >/dev/null 2>&1
systemctl restart keepwatch-agent
sleep 2
systemctl is-active --quiet keepwatch-agent || fail "service did not start, check: journalctl -u keepwatch-agent"

say ""
say "KeepWatch agent is running. Logs: journalctl -u keepwatch-agent -f"
