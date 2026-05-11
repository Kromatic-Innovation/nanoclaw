---
name: add-google-auth
description: Set up Google OAuth credentials for NanoClaw integrations (Gmail, Calendar, Sheets, Maps, Contacts). Supports multi-account.
---

# Add Google Auth

Sets up Google OAuth credentials that all Google integration skills depend on (Gmail, Calendar, Sheets, Maps, Contacts).

## Prerequisites

- A Google Cloud project with OAuth 2.0 credentials (client ID + client secret)
- Python 3.9+

## Installation

```bash
git fetch origin skill/google-auth
git merge origin/skill/google-auth
```

## Setup

### Step 1: Create Google Cloud OAuth credentials

If you don't already have OAuth credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select existing)
3. Enable the APIs you need: Gmail, Calendar, Sheets, People (Contacts)
4. Go to **APIs & Services > Credentials > Create Credentials > OAuth client ID**
5. Application type: **Desktop app**
6. Download the client ID and client secret

### Step 2: Store initial credentials

Create a credentials file with your client ID and secret. Choose ONE storage location:

**Option A — File (recommended for getting started):**

```bash
mkdir -p ~/.config/nanoclaw/secrets
cat > ~/.config/nanoclaw/secrets/google-gmail.json << 'EOF'
{
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET"
}
EOF
```

**Option B — Custom path via env var:**

```bash
export GOOGLE_CREDS_FILE=/path/to/your/creds.json
```

**Option C — OpenClaw compatibility:**
If migrating from OpenClaw, existing credentials at `~/.openclaw/secrets/google-gmail.json` are automatically detected.

### Step 3: Run OAuth flow

```bash
python3 scripts/google_reauth.py
```

This opens a browser for Google sign-in. Authorize all requested scopes (Gmail, Calendar, Sheets, Contacts). The script saves the refresh token to your credentials file.

### Step 4: Set up second account (optional)

```bash
python3 scripts/google_reauth.py --account 2
```

Sign in with your second Google account. Credentials are saved to a separate file (`google-gmail-2.json`).

## Credential Resolution

The script checks these locations in order (first match wins):

| Account | Env var               | XDG default                                      | OpenClaw compat                           |
| ------- | --------------------- | ------------------------------------------------ | ----------------------------------------- |
| 1       | `GOOGLE_CREDS_FILE`   | `~/.config/nanoclaw/secrets/google-gmail.json`   | `~/.openclaw/secrets/google-gmail.json`   |
| 2       | `GOOGLE_CREDS_FILE_2` | `~/.config/nanoclaw/secrets/google-gmail-2.json` | `~/.openclaw/secrets/google-gmail-2.json` |

## Verification

```bash
python3 -c "
import json, os
f = os.path.expanduser('~/.config/nanoclaw/secrets/google-gmail.json')
if not os.path.exists(f): f = os.path.expanduser('~/.openclaw/secrets/google-gmail.json')
d = json.load(open(f))
assert d.get('refresh_token'), 'No refresh token found'
print('Google auth OK — refresh token present')
"
```

## Removal

```bash
# Remove the script
rm scripts/google_reauth.py
rm -rf .claude/skills/add-google-auth

# Optionally remove credentials
rm ~/.config/nanoclaw/secrets/google-gmail*.json
```
