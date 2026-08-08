# Stable HTTPS setup

The OpenHome DevKit and your phone must reach the Bun bridge through one stable
HTTPS origin. The bridge itself should keep listening only on
`127.0.0.1:3000`; a tunnel or reverse proxy supplies HTTPS.

## Recommended: Cloudflare Tunnel

This path requires a domain managed in Cloudflare.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels**.
2. Create a Cloudflared tunnel named `openhome-gpt-live`.
3. Add a public hostname such as `voice.example.com`.
4. Set its service type to **HTTP** and its URL to
   `http://127.0.0.1:3000`.
5. On the computer running this project, follow Cloudflare's displayed connector
   command and enable it at startup.
6. Wait until the tunnel is Healthy, then verify:

   ```bash
   curl https://voice.example.com/healthz
   ```

7. Give `https://voice.example.com`—with no trailing path—to the installer as
   `PUBLIC_BASE_URL`.

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

If `cloudflared` is installed, this creates a random test URL:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

The generated `trycloudflare.com` URL changes when the process restarts. When it
changes, the Ability keeps calling the old address and the speaker appears
dead. Use this only to evaluate the integration, not for an always-on speaker.
