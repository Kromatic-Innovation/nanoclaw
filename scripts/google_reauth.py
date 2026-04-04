#!/usr/bin/env python3
"""Re-authorize Google OAuth with all required scopes.

Reads client_id/client_secret from 1Password ("Google OAuth Client" in Agent
Tools vault), runs the OAuth browser flow, and stores the new refresh token
in the per-account 1Password item.

1Password items (Agent Tools vault):
  - "Google OAuth Client"          → client-id, client-secret (shared)
  - "Google OAuth Credentials"     → refresh-token (account 1)
  - "Google OAuth Credentials 2"   → refresh-token (account 2)
"""

import argparse
import os
import subprocess
import sys


OP_VAULT = os.environ.get("GOOGLE_1PASSWORD_VAULT", "Agent Tools")
OP_CLIENT_ITEM = os.environ.get("GOOGLE_1PASSWORD_CLIENT", "Google OAuth Client")
OP_CREDS_ITEMS = {
    "1": os.environ.get("GOOGLE_1PASSWORD_ITEM", "Google OAuth Credentials"),
    "2": os.environ.get("GOOGLE_1PASSWORD_ITEM_2", "Google OAuth Credentials 2"),
}

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
]

OAUTH_SCRIPT = os.environ.get(
    "GOOGLE_OAUTH_SCRIPT",
    os.path.expanduser(
        "~/.openclaw/workspace/scripts/google_oauth_refresh_token.py"
    ),
)


def _op_run(args: list[str]) -> str:
    """Run an op CLI command and return stdout."""
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise RuntimeError("1Password CLI (`op`) not found.")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.stderr.strip() or e.stdout.strip())


def _op_read(field_path: str) -> str | None:
    """Read a field via op:// URI. Returns None on failure."""
    try:
        return _op_run(["op", "read", field_path]).strip() or None
    except RuntimeError:
        return None


def _load_client_creds() -> tuple[str, str]:
    """Load client_id and client_secret from 1Password."""
    base = f"op://{OP_VAULT}/{OP_CLIENT_ITEM}"
    client_id = _op_read(f"{base}/client-id") or _op_read(f"{base}/client_id")
    client_secret = _op_read(f"{base}/client-secret") or _op_read(f"{base}/client_secret")
    if not client_id or not client_secret:
        # Fall back to the creds item (legacy layout where all 3 fields are together)
        creds_item = OP_CREDS_ITEMS["1"]
        base2 = f"op://{OP_VAULT}/{creds_item}"
        client_id = _op_read(f"{base2}/client-id") or _op_read(f"{base2}/client_id")
        client_secret = _op_read(f"{base2}/client-secret") or _op_read(f"{base2}/client_secret")
    if not client_id or not client_secret:
        print(
            f"ERROR: Could not read client credentials from 1Password.\n"
            f"Expected item '{OP_CLIENT_ITEM}' in vault '{OP_VAULT}' "
            f"with fields 'client-id' and 'client-secret'.",
            file=sys.stderr,
        )
        sys.exit(1)
    return client_id, client_secret


def _save_refresh_token(account: str, refresh_token: str) -> None:
    """Store the refresh token in the per-account 1Password item."""
    item_name = OP_CREDS_ITEMS.get(account)
    if not item_name:
        print(f"ERROR: No 1Password item configured for account {account}", file=sys.stderr)
        sys.exit(1)

    # Check if item exists
    try:
        _op_run(["op", "item", "get", item_name, "--vault", OP_VAULT])
        # Update existing
        _op_run([
            "op", "item", "edit", item_name, "--vault", OP_VAULT,
            f"refresh-token={refresh_token}",
        ])
        print(f"Updated '{item_name}' in vault '{OP_VAULT}'.")
    except RuntimeError:
        # Create new
        _op_run([
            "op", "item", "create", "--category", "login",
            "--vault", OP_VAULT, "--title", item_name,
            f"refresh-token={refresh_token}",
        ])
        print(f"Created '{item_name}' in vault '{OP_VAULT}'.")


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

    client_id, client_secret = _load_client_creds()

    print(f"Account: {account}")
    print(f"Client ID: {client_id[:20]}...")
    print(f"Token item: {OP_CREDS_ITEMS[account]}")
    print(f"Scopes: {len(SCOPES)} ({', '.join(s.rsplit('/', 1)[-1] for s in SCOPES)})")
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

    print()
    refresh_token = input("Paste the refresh token here: ").strip()

    if not refresh_token:
        print("No refresh token provided", file=sys.stderr)
        return 1

    _save_refresh_token(account, refresh_token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
