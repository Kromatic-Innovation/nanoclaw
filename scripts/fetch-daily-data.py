#!/usr/bin/env python3
"""
Tier 0 script for the daily-briefing pipeline.

Fetches raw data from Gmail, Google Calendar, and Apple Reminders,
then outputs WorkItem[] JSON to stdout. Empty output (or []) means
no items — pipeline stops at Tier 0 with $0 cost.

Credentials: Uses the Google API wrapper scripts from OpenClaw
(~/.openclaw/workspace/scripts/) which handle 1Password / JSON
credential loading. If unavailable, gracefully returns [].

Data sources:
  1. Gmail — unread inbox, newer than 1 day
  2. Google Calendar — events for today
  3. Apple Reminders — due/overdue items (via remindctl)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

OPENCLAW_SCRIPTS = os.path.expanduser("~/.openclaw/workspace/scripts")
GMAIL_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "gmail_wrapper.py")
CALENDAR_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "google_calendar_wrapper.py")
SCRIPTS_DIR = Path(__file__).resolve().parent
SHEETS_DB = str(SCRIPTS_DIR / "sheets_contact_db.py")
SHEETS_SPREADSHEET_ID = os.environ.get("SHEETS_SPREADSHEET_ID", "")


def run_command(args: list[str], timeout: int = 20) -> str | None:
    """Run a command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def fetch_gmail() -> list[dict]:
    """Fetch unread Gmail messages as WorkItems, enriched with contact data."""
    if not os.path.exists(GMAIL_WRAPPER):
        return []

    # Fetch all inbox emails not previously triaged by claw.
    # Includes read emails — if you read it but didn't deal with it, it still needs triage.
    query = (
        "in:inbox "
        "-label:claw-triaged -label:claw-drafted "
        "-label:claw-escalated -label:claw-pending -label:claw-spam"
    )

    raw = run_command([
        "python3", GMAIL_WRAPPER,
        "list",
        "--query", query,
        "--limit", "50",
    ], timeout=30)
    if not raw:
        return []

    try:
        messages = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(messages, list):
        return []

    # Load programmatic rules (once for all emails)
    prog_rules = _load_programmatic_rules()

    # Cache contact lookups by email to avoid duplicate Sheets API calls
    contact_cache: dict[str, dict] = {}

    items = []
    now = datetime.now(timezone.utc).isoformat()
    for msg in messages:
        msg_id = msg.get("id", "")
        snippet = msg.get("snippet", "")
        subject = msg.get("subject", snippet[:80])
        sender = msg.get("from", "unknown")
        date = msg.get("date", now)

        # Extract email address from "Name <email>" format
        sender_email = _extract_email(sender)

        # Look up contact in Sheets DB
        contact = _lookup_contact_cached(sender_email, contact_cache)

        # Apply programmatic rules
        pre_category = _apply_rules(sender_email, subject, prog_rules)

        items.append({
            "id": f"gmail-{msg_id}",
            "source": "gmail",
            "type": "email",
            "summary": f"From {sender}: {subject}",
            "body": snippet,
            "metadata": {
                "messageId": msg_id,
                "from": sender,
                "from_email": sender_email,
                "subject": subject,
                "tags": contact.get("tags", ["unknown"]),
                "allowed_actions": contact.get("allowed_actions", ["escalate"]),
                "drafting_context": contact.get("drafting_context", ""),
                "contact_name": contact.get("name", ""),
                "pre_category": pre_category,
            },
            "timestamp": date,
        })

    return items


def _extract_email(sender: str) -> str:
    """Extract email from 'Name <email@domain.com>' format."""
    if "<" in sender and ">" in sender:
        return sender.split("<")[1].split(">")[0].strip().lower()
    return sender.strip().lower()


def _lookup_contact_cached(email: str, cache: dict[str, dict]) -> dict:
    """Look up contact via sheets_contact_db.py with caching."""
    if email in cache:
        return cache[email]

    if not SHEETS_SPREADSHEET_ID or not os.path.exists(SHEETS_DB):
        result = {"tags": ["unknown"], "allowed_actions": ["escalate"], "drafting_context": "", "name": ""}
        cache[email] = result
        return result

    raw = run_command(
        ["python3", SHEETS_DB, "lookup", email],
        timeout=15,
    )
    if raw:
        try:
            result = json.loads(raw)
            cache[email] = result
            return result
        except json.JSONDecodeError:
            pass

    result = {"tags": ["unknown"], "allowed_actions": ["escalate"], "drafting_context": "", "name": ""}
    cache[email] = result
    return result


def _load_programmatic_rules() -> list[dict]:
    """Load programmatic rules from the Sheets DB."""
    if not SHEETS_SPREADSHEET_ID or not os.path.exists(SHEETS_DB):
        return []

    raw = run_command(
        ["python3", SHEETS_DB, "get-rules"],
        timeout=15,
    )
    if raw:
        try:
            rules = json.loads(raw)
            return rules if isinstance(rules, list) else []
        except json.JSONDecodeError:
            pass
    return []


def _apply_rules(email: str, subject: str, rules: list[dict]) -> str | None:
    """Apply programmatic rules to classify an email."""
    if not rules:
        return None

    # Use the rule engine from sheets_contact_db
    sys.path.insert(0, str(SCRIPTS_DIR))
    try:
        from sheets_contact_db import apply_programmatic_rules
        return apply_programmatic_rules(email, subject, rules)
    except ImportError:
        return None


def fetch_calendar() -> list[dict]:
    """Fetch today's calendar events as WorkItems."""
    if not os.path.exists(CALENDAR_WRAPPER):
        return []

    raw = run_command([
        "python3", CALENDAR_WRAPPER,
        "list",
        "--calendar", "primary",
        "--days", "1",
        "--limit", "25",
    ])
    if not raw:
        return []

    try:
        events = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(events, list):
        return []

    items = []
    for event in events:
        event_id = event.get("id", "")
        summary = event.get("summary", "Untitled event")
        start = event.get("start", {})
        start_time = start.get("dateTime", start.get("date", ""))
        location = event.get("location", "")
        attendees = event.get("attendees", [])

        description = f"{summary}"
        if start_time:
            description += f" at {start_time}"
        if location:
            description += f" ({location})"

        items.append({
            "id": f"cal-{event_id}",
            "source": "google-calendar",
            "type": "event",
            "summary": description,
            "metadata": {
                "eventId": event_id,
                "start": start_time,
                "location": location,
                "attendeeCount": len(attendees),
            },
            "timestamp": start_time or datetime.now(timezone.utc).isoformat(),
        })

    return items


def fetch_reminders() -> list[dict]:
    """Fetch due/overdue reminders via remindctl. Non-blocking: returns [] on any failure."""
    raw = run_command(["remindctl", "list", "--due", "--json"], timeout=10)
    if not raw:
        return []

    try:
        reminders = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(reminders, list):
        return []

    items = []
    now = datetime.now(timezone.utc).isoformat()
    for rem in reminders:
        rem_id = rem.get("id", "")
        title = rem.get("title", "Untitled")
        list_name = rem.get("list", "")
        due = rem.get("dueDate", now)

        items.append({
            "id": f"reminder-{rem_id}",
            "source": f"reminders/{list_name}" if list_name else "reminders",
            "type": "reminder",
            "summary": f"[{list_name}] {title}" if list_name else title,
            "metadata": {"list": list_name},
            "timestamp": due,
        })

    return items


def fetch_triage_summary() -> list[dict]:
    """Fetch today's already-triaged emails for the daily briefing synthesis.

    Queries Gmail for items processed by the email-triage pipeline (labeled
    with claw/* labels) in the last 24 hours. Returns WorkItems with triage
    decisions attached so the synthesize stage can recap what happened.
    """
    if not os.path.exists(GMAIL_WRAPPER):
        return []

    # Fetch emails processed by email-triage since last briefing
    query = (
        "(label:claw-triaged OR label:claw-drafted OR label:claw-escalated OR label:claw-spam) "
        "newer_than:1d"
    )

    raw = run_command([
        "python3", GMAIL_WRAPPER,
        "list",
        "--query", query,
        "--limit", "100",
    ], timeout=30)
    if not raw:
        return []

    try:
        messages = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(messages, list):
        return []

    items = []
    now = datetime.now(timezone.utc).isoformat()
    for msg in messages:
        msg_id = msg.get("id", "")
        snippet = msg.get("snippet", "")
        subject = msg.get("subject", snippet[:80])
        sender = msg.get("from", "unknown")
        date = msg.get("date", now)
        labels = msg.get("labelIds", []) or msg.get("labels", [])

        # Determine what triage action was taken based on labels
        triage_action = "triaged"
        if any("drafted" in str(l).lower() for l in labels):
            triage_action = "drafted"
        elif any("escalated" in str(l).lower() for l in labels):
            triage_action = "escalated"
        elif any("spam" in str(l).lower() for l in labels):
            triage_action = "spam"

        items.append({
            "id": f"gmail-{msg_id}",
            "source": "gmail",
            "type": "email-summary",
            "summary": f"[{triage_action}] From {sender}: {subject}",
            "body": snippet,
            "metadata": {
                "messageId": msg_id,
                "from": sender,
                "subject": subject,
                "triageAction": triage_action,
            },
            "timestamp": date,
        })

    return items


def main():
    triage_summary_mode = "--triage-summary" in sys.argv

    all_items: list[dict] = []

    if triage_summary_mode:
        # Daily briefing mode: fetch what email-triage already processed
        try:
            all_items.extend(fetch_triage_summary())
        except Exception as e:
            print(f"[fetch-daily-data] triage-summary failed: {e}", file=sys.stderr)

        # Still include calendar and reminders for the daily briefing
        for fetch_fn, name in [
            (fetch_calendar, "calendar"),
            (fetch_reminders, "reminders"),
        ]:
            try:
                all_items.extend(fetch_fn())
            except Exception as e:
                print(f"[fetch-daily-data] {name} failed: {e}", file=sys.stderr)
    else:
        # Normal mode: fetch new unprocessed items
        for fetch_fn, name in [
            (fetch_gmail, "gmail"),
            (fetch_calendar, "calendar"),
            (fetch_reminders, "reminders"),
        ]:
            try:
                all_items.extend(fetch_fn())
            except Exception as e:
                print(f"[fetch-daily-data] {name} failed: {e}", file=sys.stderr)

    json.dump(all_items, sys.stdout)


if __name__ == "__main__":
    main()
