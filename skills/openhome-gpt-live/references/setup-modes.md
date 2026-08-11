# Setup modes

## Interactive default

Run `./install.sh`. The wizard detects reusable configuration and offers:

1. an existing stable HTTPS origin;
2. a persistent, account-linked Cloudflare Tunnel;
3. a temporary Quick Tunnel for evaluation;
4. host-only setup to finish later.

Codex, an OpenHome API key, AgentMail, automatic Ability upload, and tunnel
management are optional. Configure voice email separately with `bun run
agentmail:setup`; its API key must use hidden input or the environment. ChatGPT
identity and a reachable HTTPS origin are required only before the production
bridge can start.

## Agent or automation

Inspect `./install.sh --help` and pass only non-secret values as flags. Supply
secrets through the environment or the interactive hidden prompt. Prefer:

```bash
./install.sh \
  --non-interactive \
  --email user@example.com \
  --tunnel existing \
  --public-url https://voice.example.com \
  --workspace /absolute/path
```

Use `--tunnel cloudflare --hostname voice.example.com` for a named tunnel when
`cloudflared` is installed and the user has authorized the account. Use
`--tunnel quick` only for evaluation. Use `--tunnel later` to configure the
host without starting the production service.

Re-running the installer is the update path. Do not reset, clean, or overwrite
an existing checkout with local changes. Report the exact safe action needed.

## Persistent Cloudflare mode

The repository creates or reuses one named tunnel, writes a project-specific
config outside the checkout's tracked files, routes the chosen hostname, and
installs a user launchd/systemd service. It does not replace the user's global
Cloudflare configuration. Run `bun run tunnel -- status` for a redacted status.

Cloudflare login and DNS ownership are human actions. A Linux user service may
need `loginctl enable-linger` if the owner requires it to survive logout.

## Finish flow

Run `bun run finish`. It prints the two OpenHome keys, the dashboard steps, and
then waits for the private pairing inbox. The user opens the printed `/setup`
link in any trusted browser and completes Login with ChatGPT device-code auth.
The page is served by the host bridge; it is not part of OpenHome mobile.
