#!/usr/bin/env bash
set -euo pipefail

root="${OPENHOME_GPT_LIVE_INSTALL_DIR:-$(pwd)}"
failures=0

check() {
  local label="$1"
  local command_name="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '✓ %s\n' "$label"
  else
    printf '! %s is not installed\n' "$label"
    failures=$((failures + 1))
  fi
}

case "$(uname -s)" in
  Darwin|Linux) printf '✓ supported host: %s\n' "$(uname -s)" ;;
  *) printf '✗ unsupported host: %s\n' "$(uname -s)"; exit 1 ;;
esac

check "curl" curl
check "git" git
check "Bun" bun

if command -v codex >/dev/null 2>&1; then
  if codex login status >/dev/null 2>&1; then
    printf '✓ Codex is signed in\n'
  else
    printf '! Codex is installed but not signed in; voice and search can still be configured\n'
  fi
else
  printf '! Codex is optional and not installed; local tool delegation will be unavailable\n'
fi

if command -v cloudflared >/dev/null 2>&1; then
  printf '✓ cloudflared is available for persistent or temporary tunnel setup\n'
else
  printf '! cloudflared is optional; use an existing HTTPS origin or configure it later\n'
fi

if [ -d "$root/.git" ]; then
  printf '✓ existing checkout: %s\n' "$root"
  if [ -n "$(git -C "$root" status --porcelain)" ]; then
    printf '! checkout has local changes; the installer will not overwrite them\n'
  fi
else
  printf '· new installation target: %s\n' "$root"
fi

if [ "$failures" -gt 0 ]; then
  printf '\nCore bootstrap tools are missing. Run ./install.sh for guided remediation.\n'
fi
