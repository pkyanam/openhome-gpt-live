#!/usr/bin/env bash
set -euo pipefail

repository_url="${OPENHOME_GPT_LIVE_REPOSITORY_URL:-https://github.com/pkyanam/openhome-gpt-live.git}"
install_root="${OPENHOME_GPT_LIVE_INSTALL_DIR:-${HOME}/.openhome-gpt-live}"

say() {
  printf '%s\n' "$*"
}

fail() {
  say "Error: $*" >&2
  exit 1
}

say ""
say "OpenHome GPT Live installer"
say "==========================="
say ""

for command_name in curl git python3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required but was not found."
done

if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="${BUN_INSTALL:-${HOME}/.bun}/bin:${PATH}"
fi
command -v bun >/dev/null 2>&1 || fail "Bun was installed but is not available on PATH. Open a new terminal and run this installer again."
command -v codex >/dev/null 2>&1 || fail "Codex CLI is required. Install/sign in to Codex, then run this installer again."
codex login status >/dev/null 2>&1 || fail "Codex is installed but not signed in. Run 'codex login', then run this installer again."

if [ -e "$install_root" ] && [ ! -d "$install_root/.git" ]; then
  fail "$install_root already exists and is not an OpenHome GPT Live checkout. Set OPENHOME_GPT_LIVE_INSTALL_DIR to another folder."
fi

if [ -d "$install_root/.git" ]; then
  say "Updating the existing installation..."
  git -C "$install_root" pull --ff-only
else
  say "Downloading OpenHome GPT Live to $install_root..."
  git clone --depth 1 "$repository_url" "$install_root"
fi

cd "$install_root"
say "Installing dependencies and verifying the release..."
bun install --frozen-lockfile
bun run check

if [ "${OPENHOME_GPT_LIVE_NONINTERACTIVE:-0}" = "1" ]; then
  bun run setup -- --non-interactive
else
  bun run setup </dev/tty
fi

say "Installing the always-on bridge service..."
if [ "${OPENHOME_GPT_LIVE_SKIP_SERVICE:-0}" = "1" ]; then
  say "Skipping service installation because OPENHOME_GPT_LIVE_SKIP_SERVICE=1."
else
  bun run service:install
fi

if [ "${OPENHOME_GPT_LIVE_SKIP_SERVICE:-0}" != "1" ]; then
  bridge_ready=0
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
      bridge_ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$bridge_ready" -eq 1 ] || fail "The host service did not become healthy. Run 'bun run service:status' and inspect data/server-error.log."
fi

if [ "${OPENHOME_GPT_LIVE_SKIP_SERVICE:-0}" = "1" ]; then
  bun run doctor -- --offline
else
  bun run doctor -- --require-server
fi

if [ -n "$(awk -F= '/^OPENHOME_API_KEY=/{print $2}' .env | tr -d '\"')" ]; then
  bun run upload:ability || say "Automatic Ability upload was skipped; the release ZIP is in $install_root/dist."
fi

bun run openhome:config

say ""
say "Local installation is complete."
say "Finish the short OpenHome dashboard checklist printed above and in:"
say "  https://github.com/pkyanam/openhome-gpt-live#finish-setup-in-openhome"
say "After Sync Abilities and Restart Agent, retrieve the pairing link with:"
say "  cd $install_root && bun run pairing:code -- --wait=180"
say ""
