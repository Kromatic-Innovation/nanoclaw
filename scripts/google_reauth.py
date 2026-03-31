#!/usr/bin/env python3
"""Re-authorize Google OAuth with all required scopes (including Calendar).

Reads existing client_id/client_secret from ~/.openclaw/secrets/google-gmail.json,
runs the OAuth flow with all scopes, and updates the creds file with the new
refresh token.
"""

import json
import os
import subprocess
import sys

CREDS_FILE = os.path.expanduser("~/.openclaw/secrets/google-gmail.json")

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
]

OAUTH_SCRIPT = os.path.expanduser(
    "~/.openclaw/workspace/scripts/google_oauth_refresh_token.py"
)


def main() -> int:
    if not os.path.exists(CREDS_FILE):
        print(f"Creds file not found: {CREDS_FILE}", file=sys.stderr)
        return 1

    with open(CREDS_FILE) as f:
        creds = json.load(f)

    client_id = creds.get("client_id", "").strip()
    client_secret = creds.get("client_secret", "").strip()
    if not client_id or not client_secret:
        print("Missing client_id or client_secret in creds file", file=sys.stderr)
        return 1

    print(f"Client ID: {client_id[:20]}...")
    print(f"Scopes: {' '.join(SCOPES)}")
    print()

    env = {
        **os.environ,
        "GOOGLE_CLIENT_ID": client_id,
        "GOOGLE_CLIENT_SECRET": client_secret,
        "GOOGLE_OAUTH_SCOPES": " ".join(SCOPES),
    }

    result = subprocess.run(
        ["python3", OAUTH_SCRIPT],
        env=env,
        capture_output=True,
        text=True,
    )

    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    if result.returncode != 0:
        return result.returncode

    # Extract refresh token from output
    lines = result.stdout.strip().split("\n")
    refresh_token = None
    for i, line in enumerate(lines):
        if "Refresh token:" in line:
            # Token is on the next non-empty line
            for candidate in lines[i + 1 :]:
                candidate = candidate.strip()
                if candidate:
                    refresh_token = candidate
                    break
            break

    if not refresh_token:
        print("Could not extract refresh token from output", file=sys.stderr)
        print("Please copy it manually and update the creds file", file=sys.stderr)
        return 1

    # Update creds file
    creds["refresh_token"] = refresh_token
    with open(CREDS_FILE, "w") as f:
        json.dump(creds, f, indent=2)
    print(f"\nUpdated {CREDS_FILE} with new refresh token.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
