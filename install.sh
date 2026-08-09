#!/usr/bin/env bash
set -euo pipefail

repository_url="${OPENHOME_GPT_LIVE_REPOSITORY_URL:-https://github.com/pkyanam/openhome-gpt-live.git}"
install_root="${OPENHOME_GPT_LIVE_INSTALL_DIR:-${HOME}/.openhome-gpt-live}"
release_base="${OPENHOME_GPT_LIVE_RELEASE_BASE:-https://github.com/pkyanam/openhome-gpt-live/releases/latest/download}"
skip_checks=0
skip_service="${OPENHOME_GPT_LIVE_SKIP_SERVICE:-0}"
skip_finish=0
non_interactive="${OPENHOME_GPT_LIVE_NONINTERACTIVE:-0}"
stage="starting"
setup_args=()

say() { printf '%s\n' "$*"; }
fail() { say "Error: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
OpenHome GPT Live installer

Usage:
  ./install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash -s -- [options]

Connection modes:
  --tunnel existing       Use --public-url with an existing stable HTTPS origin
  --tunnel cloudflare     Create/reuse an account-linked named Cloudflare Tunnel
  --tunnel quick          Start a temporary evaluation tunnel
  --tunnel later          Install host files now and configure HTTPS later

Setup options:
  --public-url URL        Existing stable HTTPS origin
  --hostname HOST         DNS hostname for persistent Cloudflare mode
  --tunnel-name NAME      Cloudflare Tunnel name (default: openhome-gpt-live)
  --email EMAIL           ChatGPT account email allowed to authorize
  --workspace PATH        Folder available to Codex tools
  --access MODE           workspace, confirmed, or full
  --non-interactive       Use flags, environment, and saved values only

Installer options:
  --install-dir PATH      Installation folder (default: ~/.openhome-gpt-live)
  --repository URL        Alternate Git repository
  --skip-checks           Skip release tests (not recommended)
  --skip-service          Do not install/restart the host service
  --skip-finish           Print the resume command instead of the guided handoff
  -h, --help              Show this help

Optional components:
  Codex enables local files/projects/computer actions but is not required for
  GPT Live conversation or OpenAI web search. An OpenHome API key enables
  automatic Ability upload and account tools but is not required. Secrets are
  accepted through hidden prompts or environment variables, never CLI flags.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --install-dir) [ "$#" -ge 2 ] || fail "$1 requires a value"; install_root="$2"; shift 2 ;;
    --install-dir=*) install_root="${1#*=}"; shift ;;
    --repository) [ "$#" -ge 2 ] || fail "$1 requires a value"; repository_url="$2"; shift 2 ;;
    --repository=*) repository_url="${1#*=}"; shift ;;
    --skip-checks) skip_checks=1; shift ;;
    --skip-service) skip_service=1; shift ;;
    --skip-finish) skip_finish=1; shift ;;
    --non-interactive) non_interactive=1; setup_args+=("--non-interactive"); shift ;;
    --tunnel|--public-url|--hostname|--tunnel-name|--email|--workspace|--access)
      [ "$#" -ge 2 ] || fail "$1 requires a value"
      setup_args+=("$1" "$2")
      shift 2
      ;;
    --tunnel=*|--public-url=*|--hostname=*|--tunnel-name=*|--email=*|--workspace=*|--access=*)
      setup_args+=("$1")
      shift
      ;;
    *) fail "Unknown option: $1. Run with --help." ;;
  esac
done

on_error() {
  local exit_code=$?
  say ""
  say "Setup stopped while ${stage}. Existing configuration and state were preserved."
  say "Fix the message above, then rerun the same installer; every step is safe to repeat."
  if [ -d "$install_root" ]; then
    say "Resume directory: $install_root"
  fi
  exit "$exit_code"
}
trap on_error ERR

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "Automatic setup supports macOS and Linux." ;;
esac
[ -n "$install_root" ] || fail "Install directory cannot be empty."
[ "$install_root" != "/" ] || fail "Install directory cannot be /."

say ""
say "OpenHome GPT Live"
say "================="
say "One wizard for the host, HTTPS, OpenHome handoff, and ChatGPT pairing."
say ""

stage="checking bootstrap tools"
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v git >/dev/null 2>&1 || fail "git is required to install or safely update the checkout."

if ! command -v bun >/dev/null 2>&1; then
  stage="installing Bun"
  say "Installing Bun from bun.sh…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="${BUN_INSTALL:-${HOME}/.bun}/bin:${PATH}"
fi
command -v bun >/dev/null 2>&1 || fail "Bun was installed but is not on PATH. Open a new terminal and rerun."

if ! command -v codex >/dev/null 2>&1; then
  say "Note: Codex is not installed. Conversation and OpenAI web search can still work; local tool delegation will be unavailable."
elif ! codex login status >/dev/null 2>&1; then
  say "Note: Codex is not signed in. You can finish speaker setup and sign in later."
fi

stage="installing repository files"
if [ -e "$install_root" ] && [ ! -d "$install_root/.git" ]; then
  fail "$install_root exists but is not this Git checkout. Choose --install-dir with another path."
fi

if [ -d "$install_root/.git" ]; then
  say "Found an existing installation."
  if [ -n "$(git -C "$install_root" status --porcelain)" ]; then
    say "Local changes detected; using them as-is and skipping the update so nothing is overwritten."
  else
    current_branch="$(git -C "$install_root" branch --show-current)"
    if [ "$current_branch" = "main" ]; then
      git -C "$install_root" fetch --quiet origin main
      git -C "$install_root" merge --ff-only origin/main
    else
      say "Checkout is on $current_branch; keeping that branch instead of switching it."
    fi
  fi
else
  say "Downloading to $install_root…"
  git clone --depth 1 "$repository_url" "$install_root"
fi

cd "$install_root"
stage="installing dependencies"
bun install --frozen-lockfile

stage="verifying the release"
if [ "$skip_checks" = "1" ]; then
  say "Skipping release checks by request."
elif command -v python3 >/dev/null 2>&1; then
  bun run check
else
  say "Python is unavailable; running host tests and downloading the prebuilt Ability assets."
  bun run typecheck
  bun test
  mkdir -p dist
  curl -fsSL "$release_base/openhome-gpt-live-ability.zip" -o dist/openhome-gpt-live-ability.zip
  curl -fsSL "$release_base/openhome-gpt-live-ability.zip.sha256" -o dist/openhome-gpt-live-ability.zip.sha256
  curl -fsSL "$release_base/openhome-gpt-live-release.zip" -o dist/openhome-gpt-live-release.zip
fi

stage="saving configuration"
if [ "$non_interactive" = "1" ]; then
  bun run setup -- "${setup_args[@]}"
else
  bun run setup -- "${setup_args[@]}" </dev/tty
fi

bridge_ready=0
if bun scripts/configured.ts bridge; then bridge_ready=1; fi

if [ "$skip_service" = "1" ]; then
  say "Host service installation was skipped by request."
elif [ "$bridge_ready" = "1" ]; then
  stage="starting the host service"
  bun run service:install
  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$attempt" -lt 20 ] || fail "The host service did not become healthy. Run bun run service:status and inspect data/server-error.log."
else
  say "Production service not started yet because HTTPS or ChatGPT email is deferred."
fi

stage="running health checks"
if [ "$bridge_ready" = "1" ] && [ "$skip_service" != "1" ]; then
  bun run doctor -- --require-server
else
  bun run doctor -- --offline
fi

if bun scripts/configured.ts openhome; then
  stage="uploading the OpenHome Ability"
  bun run upload:ability || say "Automatic Ability upload could not complete. The manual ZIP remains in $install_root/dist."
else
  say "OpenHome API automation is not configured; use dist/openhome-gpt-live-ability.zip in My Abilities."
fi

say ""
say "Host installation complete. Re-run this installer any time to update or resume."
if [ "$bridge_ready" = "1" ] && [ "$skip_finish" != "1" ] && [ "$non_interactive" != "1" ]; then
  stage="waiting for the OpenHome handoff"
  bun run finish </dev/tty
else
  say "Next: cd $install_root && bun run finish"
fi
say ""
