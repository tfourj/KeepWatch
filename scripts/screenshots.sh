#!/bin/sh
# Regenerates the README screenshots in docs/screenshots from the demo build and its made-up data.
# Needs only Docker. Usage: sh scripts/screenshots.sh [dark|light]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
THEME="${1:-dark}"
NAME="keepwatch-screenshots"
MODULES_VOLUME="keepwatch-node-modules"
BUN_IMAGE="oven/bun:1"
CHROME_IMAGE="zenika/alpine-chrome:with-puppeteer"
OWNER="$(id -u):$(id -g)"

case "$THEME" in
  dark | light) ;;
  *) echo "usage: $0 [dark|light]" >&2; exit 1 ;;
esac

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "Building the demo..."
docker run --rm -v "$ROOT:/app" -v "$MODULES_VOLUME:/app/node_modules" -w /app "$BUN_IMAGE" \
  sh -c "bun install --frozen-lockfile >/dev/null && bun run build:demo >/dev/null && chown -R $OWNER dist"

echo "Serving the demo..."
docker run -d --name "$NAME" -v "$ROOT:/app:ro" -w /app "$BUN_IMAGE" bun scripts/screenshots/serve.ts >/dev/null

tries=0
until docker exec "$NAME" bun -e 'process.exit((await fetch("http://localhost:4321/")).ok ? 0 : 1)' >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then
    echo "The demo server did not start:" >&2
    docker logs "$NAME" >&2
    exit 1
  fi
  sleep 1
done

echo "Capturing $THEME screenshots..."
mkdir -p "$ROOT/docs/screenshots"
docker run --rm --user root --network "container:$NAME" \
  -v "$ROOT/scripts/screenshots:/work:ro" -v "$ROOT/docs/screenshots:/out" \
  -w /usr/src/app -e NODE_PATH=/usr/src/app/node_modules -e THEME="$THEME" \
  --entrypoint sh "$CHROME_IMAGE" \
  -c "apk add --no-cache font-inter >/dev/null && fc-cache -f >/dev/null && node /work/shoot.js && chown -R $OWNER /out"

echo "Done. Screenshots are in docs/screenshots."
