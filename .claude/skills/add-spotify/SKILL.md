---
name: add-spotify
description: Add Spotify integration to NanoClaw agents. Agents can search artists, check follows, and manage artist follows via MCP tools. Uses IPC bridge with macOS Keychain for credential storage. Triggers on "add spotify", "spotify integration", "spotify tools".
---

# Add Spotify

Adds Spotify artist search and follow management to NanoClaw agents. The agent gets MCP tools to search for artists, view artist details, and manage followed artists on the authenticated user's Spotify account.

**Architecture:** Host-side Python wrapper communicates with the Spotify Web API. Container-side MCP server bridges agent tool calls to the host via IPC (file-based request/response). Credentials are stored in macOS Keychain (or environment variables as fallback).

## What It Provides

| Tool              | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `search_artists`  | Search for artists by name (with optional limit)|
| `get_artist`      | Get details for a Spotify artist by ID          |
| `check_following` | Check if the user follows one or more artists   |
| `follow_artist`   | Follow an artist (add to favorites)             |
| `unfollow_artist` | Unfollow an artist                              |

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f src/spotify-ipc.ts && echo "ALREADY_APPLIED" || echo "NOT_YET_APPLIED"
```

If already applied, skip to Phase 4 (configure) or Phase 5 (verify).

## Phase 2: Apply Code Changes

### Option A: Same-repo branch (default)

If `skill/spotify` branch exists on origin:

```bash
git fetch origin skill/spotify
git merge origin/skill/spotify
```

### Option B: External repo

If installing from a different NanoClaw fork:

```bash
git remote add spotify-upstream https://github.com/YOUR-ORG/nanoclaw.git
git fetch spotify-upstream skill/spotify
git merge spotify-upstream/skill/spotify
```

### Handle merge conflicts

If `package-lock.json` conflicts:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

### Validate

```bash
npm install
npm run build
```

Verify the new files exist:

```bash
ls src/spotify-ipc.ts \
   scripts/spotify_wrapper.py \
   scripts/spotify_auth.py \
   container/agent-runner/src/spotify-mcp-stdio.ts
```

## Phase 3: Build Container

Rebuild the agent container to include the new MCP server:

```bash
./container/build.sh
```

## Phase 4: Configure

Spotify integration requires a Spotify Developer application and OAuth authorization. Credentials are stored in macOS Keychain.

### Step 1: Create a Spotify App

Walk the user through this process using `AskUserQuestion`:

> **Create a Spotify Developer App:**
>
> 1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
> 2. Click **Create App**
> 3. Set the **Redirect URI** to `http://127.0.0.1:8888/callback`
> 4. Check **Web API** under "Which API/SDKs are you planning to use?"
> 5. Save the app, then copy the **Client ID** and **Client Secret**

Wait for the user to provide the Client ID and Client Secret.

### Step 2: Store credentials in macOS Keychain

```bash
security add-generic-password -a "$USER" -s spotify-client-id -w "CLIENT_ID_HERE"
security add-generic-password -a "$USER" -s spotify-client-secret -w "CLIENT_SECRET_HERE"
```

Replace `CLIENT_ID_HERE` and `CLIENT_SECRET_HERE` with the values the user provides.

### Step 3: Run the OAuth authorization flow

```bash
python3 scripts/spotify_auth.py
```

This script:
1. Reads client_id and client_secret from Keychain
2. Opens the browser for Spotify user authorization
3. Catches the OAuth callback on `http://127.0.0.1:8888/callback`
4. Exchanges the authorization code for tokens
5. Stores the refresh_token in Keychain as `spotify-refresh-token`

The scopes requested are: `user-follow-read user-follow-modify`.

### Environment variable fallback

If macOS Keychain is unavailable, credentials can be set via environment variables instead:

```bash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
```

Add these to `.env` and sync to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 5: Verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Ask the user to test by sending a message to any group:

> Send a message like "Search for the artist Radiohead on Spotify" to any chat group.

Check logs for Spotify IPC activity:

```bash
tail -20 logs/nanoclaw.log | grep -i spotify
```

Verify IPC directories exist:

```bash
ls data/sessions/*/ipc/spotify/ 2>/dev/null
```

## How It Works

### Architecture

The Spotify integration uses a three-layer architecture:

1. **Container MCP server** (`container/agent-runner/src/spotify-mcp-stdio.ts`) — exposes tools to the agent via MCP protocol. Writes JSON request files to the IPC directory and polls for responses.

2. **Host IPC handler** (`src/spotify-ipc.ts`) — watches for request files in `{group}/spotify/requests/`, dispatches to the Python wrapper, writes response files to `{group}/spotify/responses/`.

3. **Python wrapper** (`scripts/spotify_wrapper.py`) — handles Spotify Web API communication. Reads credentials from macOS Keychain (or env vars), refreshes OAuth access tokens automatically, and returns JSON results.

### Credential storage

All three credentials are stored in macOS Keychain:

| Keychain service         | Purpose                          |
| ------------------------ | -------------------------------- |
| `spotify-client-id`     | Spotify app Client ID            |
| `spotify-client-secret` | Spotify app Client Secret        |
| `spotify-refresh-token` | OAuth refresh token (long-lived) |

The Python wrapper reads these at runtime using `security find-generic-password`. Environment variables (`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`) take precedence if set.

### IPC flow

1. Agent calls an MCP tool (e.g., `search_artists`)
2. Container MCP server writes `{id}.json` to `/workspace/ipc/spotify/requests/`
3. Host IPC watcher picks up the file, deletes it, calls `spotify_wrapper.py`
4. Wrapper hits Spotify Web API, returns JSON
5. Host writes `{id}.json` to `/workspace/ipc/spotify/responses/`
6. Container MCP server reads the response and returns it to the agent

Timeout: 30 seconds per request. Poll interval: 100ms.

## Removal

To remove the Spotify skill:

1. Delete the Spotify files: `rm src/spotify-ipc.ts container/agent-runner/src/spotify-mcp-stdio.ts scripts/spotify_wrapper.py scripts/spotify_auth.py`
2. Remove the import and call from `src/ipc.ts` (the `processSpotifyIpc` import and call)
3. Remove the MCP server config from `container/agent-runner/src/index.ts` (the `spotify` entry in mcpServers and `mcp__spotify__*` in allowedTools)
4. Remove IPC dir creation from `src/container-runner.ts` (the `spotify` mkdir lines)
5. Rebuild: `npm run build && ./container/build.sh`
6. Optionally remove Keychain entries: `security delete-generic-password -s spotify-client-id`, etc.
