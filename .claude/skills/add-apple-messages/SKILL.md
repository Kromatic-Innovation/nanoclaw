---
name: add-apple-messages
description: Apple Messages (iMessage) channel for two-way communication. macOS only. Sends via AppleScript and receives by polling chat.db.
---

# Add Apple Messages (iMessage) Channel

This skill adds iMessage as a NanoClaw channel. Messages are sent via AppleScript through Messages.app and received by polling the SQLite chat database.

## Prerequisites

- macOS only (requires `osascript` and Messages.app)
- A second macOS user account signed into Messages with the agent's Apple ID (recommended for isolation)
- Full Disk Access for the NanoClaw process (to read the other user's `chat.db`)

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/apple.ts` exists. If it does, the code changes are already in place — skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch origin skill/apple-messages
git merge origin/skill/apple-messages
```

This merges in:

- `src/channels/apple.ts` — AppleChannel class with self-registration via `registerChannel`
- `import './apple.js'` appended to `src/channels/index.ts`

### Validate code changes

```bash
npm install
npm run build
```

## Phase 3: Setup

### Create second macOS user (recommended)

Messages.app only supports one Apple ID at a time. To give the agent its own iMessage identity:

1. System Settings > Users & Groups > Add User (e.g. "voltaire")
2. Log into that user via Fast User Switching
3. Open Messages.app, sign in with the agent's Apple ID
4. Switch back to your main account (the second user stays logged in)

### Configure environment

Set these in `.env`:

```
IMESSAGE_HANDLE=you@yourdomain.com
IMESSAGE_CHAT_DB=/Users/youruser/Library/Messages/chat.db
IMESSAGE_USER=youruser
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Send a test iMessage to the agent's handle. The agent should respond within a few seconds.

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -iE "(apple|imessage)"
```

## Troubleshooting

### Messages not being received

- Verify the second user is still logged in (Fast User Switching)
- Check that `IMESSAGE_CHAT_DB` path exists and is readable
- Ensure Full Disk Access is granted to the NanoClaw process

### Messages not sending

- Check that `osascript` can reach Messages.app for the configured user
- Verify `IMESSAGE_USER` matches the macOS username running Messages.app

## Removal

1. Delete `src/channels/apple.ts`
2. Remove `import './apple.js'` from `src/channels/index.ts`
3. Rebuild and restart
