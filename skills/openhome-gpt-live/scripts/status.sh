#!/usr/bin/env bash
set -euo pipefail

root="${OPENHOME_GPT_LIVE_INSTALL_DIR:-$(pwd)}"
cd "$root"

printf 'OpenHome GPT Live status\n\n'
if command -v bun >/dev/null 2>&1; then
  bun run service:status || true
  bun run doctor -- --require-server || true
else
  printf '! Bun is unavailable; host checks were skipped\n'
fi

if [ -f dist/openhome-gpt-live-ability.zip.sha256 ]; then
  printf '\nAbility checksum\n'
  sed -n '1p' dist/openhome-gpt-live-ability.zip.sha256
fi

if command -v cloudflared >/dev/null 2>&1 && [ -f data/cloudflared.yml ]; then
  printf '\nCloudflare tunnel\n'
  bun run tunnel -- status || true
fi
