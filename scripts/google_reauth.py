#!/usr/bin/env python3
"""Re-authorize Google OAuth with all required scopes.

Reads existing client_id/client_secret from the credentials file,
runs the OAuth flow with all scopes, and updates the creds file with the new
refresh token. Supports --account flag for multi-account setup.

Credential file resolution (first match wins):
  1. GOOGLE_CREDS_FILE / GOOGLE_CREDS_FILE_2 env var
  2. File at ~/.config/nanoclaw/secrets/google-gmail.json (XDG default)
  3. File at ~/.openclaw/secrets/google-gmail.json (OpenClaw compat)
"""

import argparse
import json
import os
import subprocess
import sys


def _resolve_creds_file(account: str) -> str:
    """Find the credentials file for the given account number."""
    env_key = "GOOGLE_CREDS_FILE" if account == "1" else "GOOGLE_CREDS_FILE_2"
    if os.environ.get(env_key):
        return os.environ[env_key]

    suffix = "google-gmail.json" if account == "1" else "google-gmail-2.json"
    candidates = [
        os.path.expanduser(f"~/.config/nanoclaw/secrets/{suffix}"),
        os.path.expanduser(f"~/.openclaw/secrets/{suffix}"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    # Default to XDG path (will be created)
    return candidates[0]


SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/contacts",
]

OAUTH_SCRIPT = os.environ.get(
    "GOOGLE_OAUTH_SCRIPT",
    os.path.expanduser(
        "~/.openclaw/workspace/scripts/google_oauth_refresh_token.py"
    ),
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
    creds_file = _resolve_creds_file(account)

    # For account 2, read client_id/client_secret from the primary creds file
    source_creds_file = _resolve_creds_file("1")
    if not os.path.exists(source_creds_file):
        print(f"Creds file not found: {source_creds_file}", file=sys.stderr)
        print(
            "Set GOOGLE_CREDS_FILE to point to your credentials file, or place it at "
            "~/.config/nanoclaw/secrets/google-gmail.json",
            file=sys.stderr,
        )
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
        capture_output=False,
    )

    if result.returncode != 0:
        return result.returncode

    # Prompt user to paste the refresh token
    print()
    refresh_token = input("Paste the refresh token here: ").strip()

    if not refresh_token:
        print("No refresh token provided", file=sys.stderr)
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
