---
name: add-gmail
description: Add Gmail integration (read, draft, send, label, archive emails)
---

# Add Gmail Integration

Adds Gmail read/draft/send/label/archive via the IPC bridge pattern with email-action-guard for permission-gated mutating operations.

## Prerequisites

- Merge `skill/google-auth` first -- Gmail depends on the shared Google OAuth credential infrastructure

## Installation

```bash
git merge skill/gmail
npm run build
./container/build.sh
```

## Credential Setup

Gmail uses the same credential resolution pattern as `google-auth`. The `_resolve_creds_file(account)` function checks (first match wins):

1. Environment variable `GOOGLE_CREDS_FILE` (or `GOOGLE_CREDS_FILE_2` for account 2)
2. `~/.config/nanoclaw/secrets/google-gmail.json` (XDG default)
3. `~/.openclaw/secrets/google-gmail.json` (OpenClaw compatibility)

To set up credentials:

```bash
python3 scripts/google_reauth.py --account 1
```

The credentials file must contain `client_id`, `client_secret`, and `refresh_token`.

## Multi-Account Support

Use the `--account` flag to switch between accounts:

```bash
python3 scripts/gmail_wrapper.py --account 2 list --limit 5
```

## Verification

```bash
python3 scripts/gmail_wrapper.py list --limit 5
```

## Files

| File | Purpose |
|------|---------|
| `src/gmail-ipc.ts` | Host-side Gmail IPC handler |
| `container/agent-runner/src/gmail-mcp-stdio.ts` | Container-side Gmail MCP server |
| `scripts/email-action-guard.py` | Permission gate for mutating email operations |
| `scripts/gmail_wrapper.py` | Gmail API wrapper (multi-account, flexible creds) |

## Safety

Mutating operations (send, label-add, label-remove) are gated by `email-action-guard.py`, which validates commands against the destructive actions policy before execution.
