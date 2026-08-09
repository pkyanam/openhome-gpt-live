# Stable HTTPS setup

The OpenHome DevKit and whichever trusted browser opens `/setup` must reach the
Bun bridge through one stable HTTPS origin. The browser may run on the host,
another computer, a phone, or a tablet; `/setup` is not embedded in the
OpenHome mobile app. The bridge itself should keep listening only on
`127.0.0.1:3000`; a tunnel or reverse proxy supplies HTTPS.

## Recommended: persistent Cloudflare Tunnel

This path requires a domain managed in Cloudflare and the `cloudflared` CLI.
The setup wizard can create or reuse a named, account-linked tunnel, route the
hostname, validate ingress, and install a user launchd/systemd service:

```bash
./install.sh --tunnel cloudflare --hostname voice.example.com
```

Or configure it from an existing checkout:

```bash
bun run setup -- --tunnel cloudflare --hostname voice.example.com
bun run tunnel -- status
```

On the first run, `cloudflared tunnel login` opens a browser so the owner can
authorize the account and choose the managed domain. The repository keeps its
own config under ignored `data/` state and does not replace the user's global
Cloudflare configuration. The named tunnel and DNS route are reused on later
runs.

Wait until the tunnel is active, then verify:

```bash
curl https://voice.example.com/healthz
```

`bun run tunnel -- uninstall` stops only the repository-managed user service;
it intentionally preserves the Cloudflare tunnel and DNS record. Cloudflare's
[locally managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
documents the underlying authorization, tunnel, DNS, and configuration model.

The hostname should return `{"status":"ok",...}` before you configure the
OpenHome Third Party Key.

## Existing reverse proxy

Any trusted HTTPS proxy works if it:

- forwards the same public origin to `http://127.0.0.1:3000`;
- permits POST request bodies used for WebRTC signaling;
- does not buffer the long-lived NDJSON event response;
- keeps idle streaming connections open for at least 30 minutes;
- preserves HTTPS awareness with `X-Forwarded-Proto: https` when applicable.

Do not expose port 3000 directly to the internet. Keep the Bun server on
loopback and let the TLS endpoint be the only public listener.

## Temporary evaluation only

Choose **Quick Tunnel** in the wizard or run:

```bash
bun run setup -- --tunnel quick
```

The helper starts it in the background for the current evaluation and captures
the URL. The generated `trycloudflare.com` URL changes when the process
restarts. When it changes, the Ability keeps calling the old address and the
speaker appears dead. Never treat this as an always-on production path.
