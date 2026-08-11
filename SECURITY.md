# Security

## Supported versions

Security fixes are applied to the latest release on `main`.

## Report a vulnerability

Please do not open a public issue for a credential leak or exploitable security
bug. Use GitHub's private vulnerability reporting for this repository. Include
the affected version, impact, and a minimal reproduction. Do not include real
ChatGPT, OpenHome, tunnel, or DevKit credentials.

## Trust boundaries

- ChatGPT access/refresh material, the OpenHome API key, and the optional
  AgentMail API key stay on the host.
- The DevKit stores only an opaque per-device credential in its mode-0600
  worker state. The enrollment token is not copied into that worker config.
- The browser profile used for `/setup` stores a distinct HttpOnly pairing
  cookie. It never receives ChatGPT bearer tokens or DevKit credentials and
  may run on the host or another trusted device.
- The raw eight-digit device pairing code is kept in a separate mode-0600 host
  inbox only so `bun run pairing:code` can display it. It expires after 15
  minutes and is removed immediately after a successful claim. The device
  registry itself stores only the code hash.
- Tool names and JSON schemas are defined by the server. Model, browser, and
  device inputs are revalidated at the execution boundary.
- Public deployments are bound to one configured ChatGPT email.
- AgentMail setup selects one exact sender inbox and supports inbox-scoped keys.
  Runtime exposes only one-recipient plain-text sends, revalidates structured
  model output, and supplies a provider idempotency key for every message.
- Consequential OpenHome mutations and confirmed host-computer tasks require an
  authenticated `/setup` approval. Spoken “yes” is not approval.

## Operator responsibilities

Use a trusted HTTPS endpoint, keep Bun bound to loopback, protect `.env` and
`data/`, and apply project updates. Back up `.env` and `data/` together;
rotating `LWC_SECRET` invalidates encrypted session state.

Use least privilege for AgentMail: scope the key to the selected inbox when
possible and grant only `inbox_read` plus `message_send`. The read permission is
used by setup and diagnostics to verify that the configured address is the
intended inbox. Never put the key in shell history or a command-line flag.

For a locally managed Cloudflare Tunnel, protect `~/.cloudflared/cert.pem` as
an account-wide management credential and the tunnel's UUID JSON file as its
run credential. The repository writes only a path reference under ignored
`data/`; it never commits either credential. `bun run tunnel -- uninstall`
stops the managed service without deleting the account tunnel or DNS record.

Workspace-only is the safe default. Full Access deliberately removes the
application approval boundary and gives voice-initiated Codex
`danger-full-access`. Only enable it on a personally controlled host and
understand that wake-word or model mistakes can cause real actions.

The Login with ChatGPT GPT Live transport is experimental and private. An
upstream protocol change can break availability even when this repository has
not changed. No public API stability or service-level guarantee is implied.
