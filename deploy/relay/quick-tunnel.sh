#!/usr/bin/env bash
# Starts the private zcode relay plus a Cloudflare *quick tunnel* — a random
# https://<name>.trycloudflare.com hostname that needs no Cloudflare account.
# Quick tunnels are for ad-hoc testing only: the hostname changes on every
# start. Use a named tunnel for anything durable (docs/REMOTE-RELAY.md).
#
# Usage: deploy/relay/quick-tunnel.sh [port] [state-file]
set -euo pipefail

port="${1:-8787}"
state="${2:-$HOME/.zcode-relay/state.json}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

command -v cloudflared > /dev/null || {
  echo "cloudflared is not installed: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
}

runtime=(bun "$root/src/relay/main.ts")
if ! command -v bun > /dev/null; then
  if [ -f "$root/relay/dist/zcode-relay.js" ]; then
    runtime=(node "$root/relay/dist/zcode-relay.js")
  else
    echo "bun is not installed and relay/dist/zcode-relay.js is not built (run: bun run build:relay)" >&2
    exit 1
  fi
fi

"${runtime[@]}" --port "$port" --state "$state" &
relay_pid=$!
trap 'kill "$relay_pid" 2> /dev/null || true' EXIT INT TERM

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$port/healthz" > /dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -sf "http://127.0.0.1:$port/healthz" > /dev/null || {
  echo "relay did not become healthy on port $port" >&2
  exit 1
}

echo
echo "Relay healthy on http://127.0.0.1:$port — starting the quick tunnel."
echo "Use the printed https://....trycloudflare.com hostname like:"
echo "  zcode remote link create --relay https://<name>.trycloudflare.com/remote/v4"
echo
exec cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port"
