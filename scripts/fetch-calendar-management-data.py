#!/usr/bin/env python3
"""
Tier 0 gather script for the calendar-management pipeline.

Fetches today's calendar events, identifies consecutive event pairs,
and calls Google Maps for travel estimates between events that have
explicit locations. Events without locations are marked
'needs-classification' for the classify stage, which uses the full
calendar context to determine where Tristan currently is (he travels).

Idempotency: existing travel events tagged [claw/travel] are detected
and skipped.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

OPENCLAW_SCRIPTS = os.path.expanduser("~/.openclaw/workspace/scripts")
CALENDAR_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "google_calendar_wrapper.py")
SCRIPTS_DIR = Path(__file__).resolve().parent
MAPS_WRAPPER = str(SCRIPTS_DIR / "google_maps_wrapper.py")

# Video conferencing patterns — no travel needed
VIDEO_PATTERNS = [
    "zoom.us", "zoom.com", "meet.google.com", "teams.microsoft.com",
    "webex.com", "whereby.com", "around.co", "gather.town",
    "cal.com", "calendly.com",
]

# Transport mode emoji mapping
MODE_EMOJI = {
    "walk": "\U0001f6b6",      # 🚶
    "transit": "\U0001f68c",   # 🚌
    "drive": "\U0001f697",     # 🚗
    "bicycle": "\U0001f6b2",   # 🚲
}

WALK_MAX_MINUTES = 30


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] fetch-calendar-management: {msg}", file=sys.stderr)


def run_command(args: list[str], timeout: int = 20) -> str | None:
    """Run a command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def load_config() -> dict:
    """Load calendarManagement config from config/private.yaml."""
    config_path = SCRIPTS_DIR.parent / "config" / "private.yaml"
    if not config_path.exists():
        return {}
    try:
        import yaml
        with open(config_path) as f:
            data = yaml.safe_load(f) or {}
        return data.get("calendarManagement", {}) or {}
    except ImportError:
        return {}


def fetch_events() -> list[dict]:
    """Fetch today's calendar events from Google Calendar."""
    if not os.path.exists(CALENDAR_WRAPPER):
        log("Calendar wrapper not found")
        return []

    raw = run_command([
        "python3", CALENDAR_WRAPPER,
        "list", "--calendar", "primary",
        "--days", "1", "--limit", "25",
    ], timeout=20)
    if not raw:
        return []

    try:
        events = json.loads(raw)
    except json.JSONDecodeError:
        return []

    return events if isinstance(events, list) else []


def is_all_day(event: dict) -> bool:
    """Check if an event is all-day (has 'date' but no 'dateTime')."""
    start = event.get("start", {})
    return "date" in start and "dateTime" not in start


def is_travel_event(event: dict) -> bool:
    """Check if this is an existing claw-managed travel event."""
    desc = event.get("description", "") or ""
    return "[claw/travel]" in desc


def has_video_link(event: dict) -> bool:
    """Check if the event has a video conferencing link."""
    location = (event.get("location", "") or "").lower()
    description = (event.get("description", "") or "").lower()
    combined = location + " " + description
    return any(pattern in combined for pattern in VIDEO_PATTERNS)


def parse_event_time(event: dict, field: str) -> datetime | None:
    """Parse start or end dateTime from an event."""
    time_obj = event.get(field, {})
    dt_str = time_obj.get("dateTime", "")
    if not dt_str:
        return None
    try:
        return datetime.fromisoformat(dt_str)
    except ValueError:
        return None


def get_travel_time(
    origin: str, destination: str, mode: str, departure: str | None = None,
) -> dict | None:
    """Call Google Maps distance API and return result dict."""
    if not os.path.exists(MAPS_WRAPPER):
        log("Maps wrapper not found")
        return None

    args = [
        "python3", MAPS_WRAPPER, "distance",
        "--origin", origin,
        "--destination", destination,
        "--mode", mode,
    ]
    if departure:
        args.extend(["--departure", departure])

    raw = run_command(args, timeout=15)
    if not raw:
        return None

    try:
        result = json.loads(raw)
        if "error" in result:
            return None
        return result
    except json.JSONDecodeError:
        return None


def is_transit_city(location: str, transit_cities: list[str]) -> bool:
    """Check if a location is in a transit-friendly city."""
    loc_lower = location.lower()
    return any(city.lower() in loc_lower for city in transit_cities)


def choose_travel_mode(
    origin: str,
    destination: str,
    gap_minutes: int,
    transit_cities: list[str],
    departure_iso: str | None = None,
) -> dict | None:
    """
    Try transport modes in preference order and return the best fit.
    Returns dict with mode, duration_minutes, distance_miles, emoji, fits.
    """
    # 1. Try walking first
    walk = get_travel_time(origin, destination, "walk", departure_iso)
    if walk and walk.get("duration_minutes", 999) <= WALK_MAX_MINUTES:
        mins = walk["duration_minutes"]
        return {
            "mode": "walk",
            "duration_minutes": mins,
            "duration_text": walk.get("duration_text", f"{mins} min"),
            "distance_miles": walk.get("distance_miles", 0),
            "emoji": MODE_EMOJI["walk"],
            "fits": mins <= gap_minutes,
        }

    # 2. Try transit if in a transit-friendly city
    if is_transit_city(origin, transit_cities) or is_transit_city(destination, transit_cities):
        transit = get_travel_time(origin, destination, "transit", departure_iso)
        if transit and not transit.get("error"):
            mins = transit.get("duration_minutes", 999)
            return {
                "mode": "transit",
                "duration_minutes": mins,
                "duration_text": transit.get("duration_text", f"{mins} min"),
                "distance_miles": transit.get("distance_miles", 0),
                "emoji": MODE_EMOJI["transit"],
                "fits": mins <= gap_minutes,
            }

    # 3. Fallback to driving
    drive = get_travel_time(origin, destination, "drive", departure_iso)
    if drive:
        mins = drive.get("duration_minutes", 999)
        return {
            "mode": "drive",
            "duration_minutes": mins,
            "duration_text": drive.get("duration_text", f"{mins} min"),
            "distance_miles": drive.get("distance_miles", 0),
            "emoji": MODE_EMOJI["drive"],
            "fits": mins <= gap_minutes,
        }

    # 4. Walking as last resort (even if >30 min)
    if walk:
        mins = walk["duration_minutes"]
        return {
            "mode": "walk",
            "duration_minutes": mins,
            "duration_text": walk.get("duration_text", f"{mins} min"),
            "distance_miles": walk.get("distance_miles", 0),
            "emoji": MODE_EMOJI["walk"],
            "fits": mins <= gap_minutes,
        }

    return None


def find_existing_travel_events(
    all_events: list[dict], event_a_end: datetime, event_b_start: datetime,
) -> bool:
    """Check if a [claw/travel] event already exists between two events."""
    for event in all_events:
        if not is_travel_event(event):
            continue
        ev_start = parse_event_time(event, "start")
        if ev_start and event_a_end <= ev_start <= event_b_start:
            return True
    return False


def main() -> None:
    config = load_config()
    transit_cities = config.get("transitCities", [
        "New York", "San Francisco", "Chicago", "Boston",
        "Washington", "Philadelphia", "Portland", "Seattle",
    ])

    all_events = fetch_events()
    if not all_events:
        json.dump([], sys.stdout)
        return

    # Filter and sort events
    timed_events = []
    for event in all_events:
        if is_all_day(event):
            continue
        if is_travel_event(event):
            continue
        start = parse_event_time(event, "start")
        end = parse_event_time(event, "end")
        if start and end:
            timed_events.append({**event, "_start": start, "_end": end})

    timed_events.sort(key=lambda e: e["_start"])

    if len(timed_events) < 2:
        json.dump([], sys.stdout)
        return

    items: list[dict] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for i in range(len(timed_events) - 1):
        event_a = timed_events[i]
        event_b = timed_events[i + 1]

        a_id = event_a.get("id", "")
        b_id = event_b.get("id", "")
        a_summary = event_a.get("summary", "Untitled")
        b_summary = event_b.get("summary", "Untitled")
        a_location = (event_a.get("location", "") or "").strip()
        b_location = (event_b.get("location", "") or "").strip()
        a_end: datetime = event_a["_end"]
        b_start: datetime = event_b["_start"]

        gap_seconds = (b_start - a_end).total_seconds()
        gap_minutes = int(gap_seconds / 60)

        # Check if travel event already exists
        if find_existing_travel_events(all_events, a_end, b_start):
            items.append({
                "id": f"travel-{a_id}-{b_id}",
                "source": "calendar-management",
                "type": "travel-pair",
                "summary": f"Travel already scheduled: {a_summary} \u2192 {b_summary}",
                "body": "",
                "metadata": {
                    "event_a": {
                        "id": a_id, "summary": a_summary,
                        "start": event_a.get("start", {}),
                        "end": event_a.get("end", {}),
                        "location": a_location,
                    },
                    "event_b": {
                        "id": b_id, "summary": b_summary,
                        "start": event_b.get("start", {}),
                        "end": event_b.get("end", {}),
                        "location": b_location,
                    },
                    "gap_minutes": gap_minutes,
                    "status": "already-exists",
                },
                "timestamp": now_iso,
            })
            continue

        # Determine if events are virtual (no travel)
        a_virtual = has_video_link(event_a)
        b_virtual = has_video_link(event_b)

        if a_virtual and b_virtual:
            continue

        # Use explicit locations where available
        a_loc = a_location if a_location and not a_virtual else ""
        b_loc = b_location if b_location and not b_virtual else ""

        # If either location is missing, needs classification
        # The classify stage has full calendar context to determine
        # where Tristan currently is (he travels)
        if not a_loc or not b_loc:
            body_data = {
                "event_a": {
                    "summary": a_summary,
                    "location": a_location,
                    "description": (event_a.get("description", "") or "")[:200],
                    "is_virtual": a_virtual,
                },
                "event_b": {
                    "summary": b_summary,
                    "location": b_location,
                    "description": (event_b.get("description", "") or "")[:200],
                    "is_virtual": b_virtual,
                },
            }
            items.append({
                "id": f"travel-{a_id}-{b_id}",
                "source": "calendar-management",
                "type": "travel-pair",
                "summary": f"Needs location check: {a_summary} \u2192 {b_summary}",
                "body": json.dumps(body_data),
                "metadata": {
                    "event_a": {
                        "id": a_id, "summary": a_summary,
                        "start": event_a.get("start", {}),
                        "end": event_a.get("end", {}),
                        "location": a_location,
                    },
                    "event_b": {
                        "id": b_id, "summary": b_summary,
                        "start": event_b.get("start", {}),
                        "end": event_b.get("end", {}),
                        "location": b_location,
                    },
                    "gap_minutes": gap_minutes,
                    "status": "needs-classification",
                },
                "timestamp": now_iso,
            })
            continue

        # Same location — no travel needed
        if a_loc.lower().strip() == b_loc.lower().strip():
            continue

        # Overlapping events — impossible
        if gap_minutes <= 0:
            items.append({
                "id": f"travel-{a_id}-{b_id}",
                "source": "calendar-management",
                "type": "travel-pair",
                "summary": f"Overlapping events: {a_summary} \u2192 {b_summary}",
                "body": "",
                "metadata": {
                    "event_a": {
                        "id": a_id, "summary": a_summary,
                        "start": event_a.get("start", {}),
                        "end": event_a.get("end", {}),
                        "location": a_loc,
                    },
                    "event_b": {
                        "id": b_id, "summary": b_summary,
                        "start": event_b.get("start", {}),
                        "end": event_b.get("end", {}),
                        "location": b_loc,
                    },
                    "gap_minutes": gap_minutes,
                    "status": "impossible",
                },
                "timestamp": now_iso,
            })
            continue

        # Both locations known — calculate travel time
        departure_iso = a_end.isoformat()
        travel = choose_travel_mode(a_loc, b_loc, gap_minutes, transit_cities, departure_iso)

        if not travel:
            log(f"Maps API returned no results for {a_loc} \u2192 {b_loc}")
            continue

        status = "needs-travel" if travel["fits"] else "impossible"

        a_short = a_loc.split(",")[0] if "," in a_loc else a_loc
        b_short = b_loc.split(",")[0] if "," in b_loc else b_loc

        items.append({
            "id": f"travel-{a_id}-{b_id}",
            "source": "calendar-management",
            "type": "travel-pair",
            "summary": f"{travel['emoji']} {a_short} \u2192 {b_short}: {travel['duration_text']} ({travel['mode']})",
            "body": "",
            "metadata": {
                "event_a": {
                    "id": a_id, "summary": a_summary,
                    "start": event_a.get("start", {}),
                    "end": event_a.get("end", {}),
                    "location": a_loc,
                },
                "event_b": {
                    "id": b_id, "summary": b_summary,
                    "start": event_b.get("start", {}),
                    "end": event_b.get("end", {}),
                    "location": b_loc,
                },
                "gap_minutes": gap_minutes,
                "travel": travel,
                "status": status,
            },
            "timestamp": now_iso,
        })

    json.dump(items, sys.stdout)


if __name__ == "__main__":
    main()
