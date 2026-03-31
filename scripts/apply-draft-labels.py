#!/usr/bin/env python3
"""
Post-hook for the reason stage: apply claw/drafted labels and create Gmail drafts.

Reads the reasoning stage output from stdin (expected to be a JSON array of
per-email results with action, draftText, and id fields).

For items with action=draft or action=send:
- Creates a Gmail draft via email-action-guard.py
- Applies the claw/drafted label

This runs as a tickle-stick post-hook after the expensive model per-email reasoning stage.
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
    print(f"[{ts}] apply-draft-labels: {msg}", file=sys.stderr)


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


def create_draft(to: str, subject: str, body: str) -> bool:
    """Create a Gmail draft via the action guard."""
    script = EMAIL_ACTION_GUARD if os.path.exists(EMAIL_ACTION_GUARD) else GMAIL_WRAPPER
    try:
        subprocess.run(
            [
                "python3", script, "draft-new",
                "--to", to,
                "--subject", subject,
                "--body", body,
            ],
            timeout=30,
            capture_output=True,
            text=True,
        )
        return True
    except Exception as e:
        log(f"Failed to create draft for {to}: {e}")
        return False


def main() -> None:
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        log("No input on stdin")
        return

    # The reasoning stage output may be a JSON array or text containing JSON
    try:
        results = json.loads(stdin_data)
    except json.JSONDecodeError:
        # Try to extract JSON array from the text
        import re
        match = re.search(r'\[[\s\S]*\]', stdin_data)
        if not match:
            log("No JSON array found in reasoning output")
            return
        try:
            results = json.loads(match.group())
        except json.JSONDecodeError:
            log("Failed to parse extracted JSON array")
            return

    if not isinstance(results, list):
        log("Expected JSON array")
        return

    labels_applied = 0
    drafts_created = 0

    for item in results:
        action = item.get("action", "")
        item_id = item.get("id", "")

        # Extract raw Gmail message ID
        message_id = item_id[6:] if item_id.startswith("gmail-") else item_id
        if not message_id:
            continue

        if action in ("draft", "send"):
            # Apply claw/drafted label
            if apply_label(message_id, "claw/drafted"):
                labels_applied += 1

            # Create Gmail draft if draft text is provided
            draft_text = item.get("draftText")
            to = item.get("to", "")
            subject = item.get("subject", "")
            if draft_text and to:
                if create_draft(to, subject, draft_text):
                    drafts_created += 1

        elif action == "escalate":
            apply_label(message_id, "claw/escalated")
            labels_applied += 1

        elif action == "spam":
            apply_label(message_id, "claw/spam")
            labels_applied += 1

    if labels_applied > 0 or drafts_created > 0:
        log(f"Applied {labels_applied} labels, created {drafts_created} drafts")


if __name__ == "__main__":
    main()
