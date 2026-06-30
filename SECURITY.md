# Security Policy

This dashboard is intended for trusted local networks only.

## What the server reads

- Claude usage cache: `~/.claude/usage-cache.json`
- Codex session logs: `~/.codex/sessions/**/rollout-*.jsonl`

The dashboard does not upload these files anywhere. It only renders a local web page and a local JSON API.

## What not to commit

Do not commit:

- `~/.claude/usage-cache.json`
- `~/.codex/sessions`
- `~/.claude/settings.json`
- `config.json`
- screenshots that expose account, path, workspace, or session details

## Network exposure

By default, `server.js` listens on `0.0.0.0` so a phone or tablet on the same Wi-Fi can open it.

Do not expose this port to the public internet. If you only want local preview, run:

```powershell
$env:HOST="127.0.0.1"; node server.js
```

## Reporting issues

If you find a security issue, please open a private advisory or contact the maintainer directly instead of posting sensitive details in a public issue.
