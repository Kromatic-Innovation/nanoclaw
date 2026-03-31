#!/usr/bin/env python3
"""
Post-hook for applying claw/triaged labels after successful briefing delivery.

Reads all items from stdin (JSON array). For every gmail item, applies
the claw/triaged label via email-action-guard.py.

This script is an alternative to the TypeScript callback stage — it can be
used as a post-hook on the synthesize stage if you want labels applied
after synthesis completes rather than after delivery confirmation.
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

EMAIL_ACTION_GUARD = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "email-action-guard.py"
)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] apply-triaged-labels: {msg}", file=sys.stderr)


def apply_label(message_id: str, label: str) -> bool:
    """Apply a claw/* label to a Gmail message via the action guard."""
    script = EMAIL_ACTION_GUARD if os.path.exists(EMAIL_ACTION_GUARD) else GMAIL_WRAPPER
    try:
        subprocess.run(
            ["python3", script, "label-add", "--id", message_id, "--labels", label],
            timeout=15,
            capture_output=True,
            text=True,
        )
        return True
    except Exception as e:
        log(f"Failed to apply {label} to {message_id}: {e}")
        return False


def main() -> None:
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        log("No input on stdin")
        return

    try:
        items = json.loads(stdin_data)
    except json.JSONDecodeError:
        log("Failed to parse stdin as JSON")
        return

    if not isinstance(items, list):
        log("Expected JSON array on stdin")
        return

    applied = 0
    for item in items:
        source = item.get("source", "")
        item_id = item.get("id", "")

        if source != "gmail":
            continue

        # Extract raw Gmail message ID (strip "gmail-" prefix)
        message_id = item_id[6:] if item_id.startswith("gmail-") else item_id
        if not message_id:
            continue

        if apply_label(message_id, "claw/triaged"):
            applied += 1

    if applied > 0:
        log(f"Applied claw/triaged to {applied} items")


if __name__ == "__main__":
    main()
