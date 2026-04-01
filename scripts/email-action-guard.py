#!/usr/bin/env python3
"""
Email action guard — safety net for gmail_wrapper.py calls.

Intercepts gmail_wrapper.py commands and validates them against the
contact database in Google Sheets. Blocks actions that exceed the
contact's allowed permissions.

Usage (as a wrapper):
  python3 scripts/email-action-guard.py <gmail_wrapper_args...>

The guard:
1. Parses the gmail_wrapper command and arguments
2. Determines the action type (send, draft, label, delete, list, get, etc.)
3. For mutating actions, looks up the target contact's allowed_actions
4. Blocks if the action is not permitted
5. Logs all decisions (allowed and blocked) to stderr
6. If allowed, passes through to gmail_wrapper.py

Actions and their permission requirements:
  - list, get, thread, labels  → always allowed (read-only)
  - draft-new, draft-reply, draft-reply-all → requires "draft"
  - send-new, send-reply-all → requires "send"
  - label-add, label-remove → requires "add-label" (except claw/* labels)
  - label-create → always allowed (operational)

Environment:
  GMAIL_WRAPPER_PATH  — path to gmail_wrapper.py (default: ~/.openclaw/workspace/scripts/gmail_wrapper.py)
  SHEETS_SPREADSHEET_ID — required for contact lookups
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

GMAIL_WRAPPER = os.environ.get(
    "GMAIL_WRAPPER_PATH",
    os.path.expanduser("~/.openclaw/workspace/scripts/gmail_wrapper.py"),
)

# Actions that don't require permission checks
READ_ONLY_COMMANDS = {"list", "get", "thread", "labels", "label-create"}

# Map gmail_wrapper commands to required permission
COMMAND_PERMISSION_MAP = {
    "draft-new": "draft",
    "draft-reply": "draft",
    "draft-reply-all": "draft",
    "send-new": "send",
    "send-reply-all": "send",
    "label-add": "add-label",
    "label-remove": "add-label",
}

# claw/* labels are always allowed (internal bookkeeping)
CLAW_LABEL_PREFIX = "claw"

# Archive (remove INBOX label) is always allowed — it's non-destructive
ARCHIVE_COMMANDS = {"archive"}


def log(message: str) -> None:
    print(f"[email-action-guard] {message}", file=sys.stderr, flush=True)


def extract_command_and_target(args: list[str]) -> tuple[str, str | None]:
    """Extract the gmail_wrapper command and target email/recipient from args.

    Returns (command, target_email_or_None).
    """
    if not args:
        return "", None

    command = args[0]

    # Extract --to for send/draft commands
    for i, arg in enumerate(args):
        if arg == "--to" and i + 1 < len(args):
            return command, args[i + 1]

    # For reply commands, we'd need to look up the message to find the recipient.
    # For now, extract --id and note that the guard will need to resolve it.
    for i, arg in enumerate(args):
        if arg == "--id" and i + 1 < len(args):
            return command, None  # Can't determine recipient from message ID alone

    return command, None


def is_claw_label_operation(args: list[str]) -> bool:
    """Check if this is a label operation on claw/* labels (always allowed)."""
    command = args[0] if args else ""
    if command not in ("label-add", "label-remove"):
        return False

    for i, arg in enumerate(args):
        if arg == "--labels" and i + 1 < len(args):
            labels = args[i + 1].split(",")
            return all(
                label.strip().startswith(CLAW_LABEL_PREFIX + "/")
                or label.strip().startswith(CLAW_LABEL_PREFIX + "-")
                for label in labels
            )
    return False


def lookup_contact_permissions(email_addr: str) -> list[str]:
    """Look up allowed actions for a contact via sheets_contact_db.py."""
    script = os.path.join(os.path.dirname(__file__), "sheets_contact_db.py")
    if not os.path.exists(script):
        log(f"sheets_contact_db.py not found at {script}, blocking by default")
        return []

    spreadsheet_id = os.environ.get("SHEETS_SPREADSHEET_ID", "")
    if not spreadsheet_id:
        log("SHEETS_SPREADSHEET_ID not set, blocking mutating actions by default")
        return []

    try:
        result = subprocess.run(
            ["python3", script, "lookup", email_addr],
            capture_output=True,
            text=True,
            timeout=15,
            env={**os.environ, "SHEETS_SPREADSHEET_ID": spreadsheet_id},
        )
        if result.returncode == 0 and result.stdout.strip():
            data = json.loads(result.stdout)
            return data.get("allowed_actions", [])
    except (subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as err:
        log(f"Contact lookup failed for {email_addr}: {err}")

    return []


def check_permission(args: list[str]) -> tuple[bool, str]:
    """Check if the gmail_wrapper command is permitted.

    Returns (allowed: bool, reason: str).
    """
    if not args:
        return True, "empty command"

    command = args[0]

    # Read-only commands are always allowed
    if command in READ_ONLY_COMMANDS:
        return True, f"read-only command: {command}"

    # Archive is always allowed (non-destructive — just removes INBOX label)
    if command in ARCHIVE_COMMANDS:
        return True, f"archive is always allowed (non-destructive)"

    # claw/* label operations are always allowed
    if is_claw_label_operation(args):
        return True, f"claw/* label operation: {command}"

    # Determine required permission
    required = COMMAND_PERMISSION_MAP.get(command)
    if required is None:
        # Unknown command — block by default
        return False, f"unknown command: {command}"

    # Extract target for permission check
    _, target_email = extract_command_and_target(args)

    if target_email:
        allowed_actions = lookup_contact_permissions(target_email)
        if required in allowed_actions:
            return True, f"{command} permitted for {target_email} (has '{required}')"
        else:
            return False, (
                f"{command} BLOCKED for {target_email}: "
                f"requires '{required}', contact has {allowed_actions}"
            )

    # No target email found — for reply commands, we can't determine the
    # recipient without reading the message. Allow draft (safe) but block send.
    if required == "draft":
        return True, f"{command} allowed (draft is safe without target resolution)"
    else:
        return False, (
            f"{command} BLOCKED: requires '{required}' but could not determine "
            f"target contact for permission check"
        )


def passthrough(args: list[str]) -> int:
    """Execute gmail_wrapper.py with the given args and return its exit code."""
    try:
        result = subprocess.run(
            ["python3", GMAIL_WRAPPER] + args,
            capture_output=False,
            timeout=60,
        )
        return result.returncode
    except subprocess.TimeoutExpired:
        log("gmail_wrapper.py timed out")
        return 1
    except (FileNotFoundError, OSError) as err:
        log(f"Failed to execute gmail_wrapper.py: {err}")
        return 1


def main():
    # All args after the script name are gmail_wrapper args
    wrapper_args = sys.argv[1:]

    if not wrapper_args:
        print("Usage: email-action-guard.py <gmail_wrapper_args...>", file=sys.stderr)
        sys.exit(1)

    allowed, reason = check_permission(wrapper_args)
    now = datetime.now(timezone.utc).isoformat()

    if allowed:
        log(f"ALLOWED [{now}]: {' '.join(wrapper_args[:4])} — {reason}")
        exit_code = passthrough(wrapper_args)
        sys.exit(exit_code)
    else:
        log(f"BLOCKED [{now}]: {' '.join(wrapper_args[:4])} — {reason}")
        # Output a structured error for the calling pipeline
        json.dump(
            {
                "error": "action_blocked",
                "reason": reason,
                "command": wrapper_args[0] if wrapper_args else "",
                "timestamp": now,
            },
            sys.stdout,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
