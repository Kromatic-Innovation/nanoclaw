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

OPENCLAW_SCRIPTS = os.path.expanduser("~/.openclaw/workspace/scripts")
GMAIL_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "gmail_wrapper.py")
CALENDAR_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "google_calendar_wrapper.py")


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
    """Fetch unread Gmail messages as WorkItems."""
    if not os.path.exists(GMAIL_WRAPPER):
        return []

    raw = run_command([
        "python3", GMAIL_WRAPPER,
        "list",
        "--query", "in:inbox is:unread newer_than:1d",
        "--limit", "20",
    ])
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

        items.append({
            "id": f"gmail-{msg_id}",
            "source": "gmail",
            "type": "email",
            "summary": f"From {sender}: {subject}",
            "body": snippet,
            "metadata": {"messageId": msg_id, "from": sender, "subject": subject},
            "timestamp": date,
        })

    return items


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
    """Fetch due/overdue reminders via remindctl."""
    raw = run_command(["remindctl", "list", "--due", "--json"])
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


def main():
    all_items: list[dict] = []

    all_items.extend(fetch_gmail())
    all_items.extend(fetch_calendar())
    all_items.extend(fetch_reminders())

    json.dump(all_items, sys.stdout)


if __name__ == "__main__":
    main()
