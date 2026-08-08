# Contributing

Issues and pull requests are welcome, especially for additional OpenHome
firmware/audio-device results.

Before opening a pull request:

```bash
bun install --frozen-lockfile
bun run check
git diff --check
```

Do not commit `.env`, `data/`, DevKit state, tunnel credentials, account email,
API keys, bearer tokens, or generated logs. The Ability ZIP must keep exactly
one top-level `openhome-gpt-live/` directory and include `__init__.py`.

Changes under `vendor/login-with-chatgpt` should be minimal, tested, and listed
in `vendor/login-with-chatgpt/UPSTREAM.md`. Prefer proposing generally useful
SDK fixes upstream.

When reporting audio problems, include OpenHome hardware/firmware, whether the
capture/playback values are `default`, the safe `live_status` output, and
redacted DevKit logs. Never attach the device config or host `.env`.
