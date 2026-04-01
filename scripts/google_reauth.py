#!/usr/bin/env python3
"""Re-authorize Google OAuth with all required scopes.

Reads existing client_id/client_secret from ~/.openclaw/secrets/google-gmail.json,
runs the OAuth flow with all scopes, and updates the creds file with the new
refresh token. Supports --account flag for multi-account setup.
"""

import argparse
import json
import os
import subprocess
import sys

CREDS_FILES = {
    "1": os.path.expanduser("~/.openclaw/secrets/google-gmail.json"),
    "2": os.path.expanduser("~/.openclaw/secrets/google-gmail-2.json"),
}

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/contacts",
]

OAUTH_SCRIPT = os.path.expanduser(
    "~/.openclaw/workspace/scripts/google_oauth_refresh_token.py"
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Re-authorize Google OAuth")
    parser.add_argument(
        "--account",
        default="1",
        choices=["1", "2"],
        help="Google account to authorize (1 = default, 2 = secondary)",
    )
    args = parser.parse_args()

    account = args.account
    creds_file = CREDS_FILES[account]

    # For account 2, read client_id/client_secret from the primary creds file
    source_creds_file = CREDS_FILES["1"]
    if not os.path.exists(source_creds_file):
        print(f"Creds file not found: {source_creds_file}", file=sys.stderr)
        return 1

    with open(source_creds_file) as f:
        source_creds = json.load(f)

    client_id = source_creds.get("client_id", "").strip()
    client_secret = source_creds.get("client_secret", "").strip()
    if not client_id or not client_secret:
        print("Missing client_id or client_secret in creds file", file=sys.stderr)
        return 1

    print(f"Account: {account}")
    print(f"Client ID: {client_id[:20]}...")
    print(f"Scopes: {' '.join(SCOPES)}")
    if account == "2":
        print("Sign in with your SECOND Google account when prompted.")
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

    # Update creds file (for account 2, create new file with shared client creds)
    creds = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
    }
    os.makedirs(os.path.dirname(creds_file), exist_ok=True)
    with open(creds_file, "w") as f:
        json.dump(creds, f, indent=2)
    print(f"\nUpdated {creds_file} with new refresh token.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
