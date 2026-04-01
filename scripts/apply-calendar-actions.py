#!/usr/bin/env python3
"""
Post-hook for the calendar-management classify stage.

Reads classify output from stdin (JSON array) and:
1. For items with status=needs-travel and travel data from gather → creates
   calendar events directly
2. For items newly classified as needs-travel by the model (with inferred
   locations) → calls Google Maps for travel time, then creates events
3. For impossible items → outputs CONFLICT lines to stderr for the
   post-deliver callback to send as Slack alerts

Idempotency: skips items with status=already-exists.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

OPENCLAW_SCRIPTS = os.path.expanduser("~/.openclaw/workspace/scripts")
CALENDAR_WRAPPER = os.path.join(OPENCLAW_SCRIPTS, "google_calendar_wrapper.py")
SCRIPTS_DIR = Path(__file__).resolve().parent
MAPS_WRAPPER = str(SCRIPTS_DIR / "google_maps_wrapper.py")

MODE_EMOJI = {
    "walk": "\U0001f6b6",
    "transit": "\U0001f68c",
    "drive": "\U0001f697",
    "bicycle": "\U0001f6b2",
}

WALK_MAX_MINUTES = 30

# Cities where transit is preferred over driving
TRANSIT_CITIES = [
    "new york", "san francisco", "chicago", "boston",
    "washington", "philadelphia", "portland", "seattle",
    "los angeles", "london", "paris", "berlin", "tokyo",
    "amsterdam", "barcelona", "lisbon",
]


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] apply-calendar-actions: {msg}", file=sys.stderr)


def run_command(args: list[str], timeout: int = 20) -> str | None:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def get_travel_time(origin: str, destination: str, mode: str, departure: str | None = None) -> dict | None:
    if not os.path.exists(MAPS_WRAPPER):
        return None
    args = [
        "python3", MAPS_WRAPPER, "distance",
        "--origin", origin, "--destination", destination, "--mode", mode,
    ]
    if departure:
        args.extend(["--departure", departure])
    raw = run_command(args, timeout=15)
    if not raw:
        return None
    try:
        result = json.loads(raw)
        return None if "error" in result else result
    except json.JSONDecodeError:
        return None


def is_transit_city(location: str) -> bool:
    loc_lower = location.lower()
    return any(city in loc_lower for city in TRANSIT_CITIES)


def choose_travel_mode(origin: str, destination: str, gap_minutes: int, departure_iso: str | None = None) -> dict | None:
    """Try transport modes in preference order."""
    walk = get_travel_time(origin, destination, "walk", departure_iso)
    if walk and walk.get("duration_minutes", 999) <= WALK_MAX_MINUTES:
        mins = walk["duration_minutes"]
        return {
            "mode": "walk", "duration_minutes": mins,
            "duration_text": walk.get("duration_text", f"{mins} min"),
            "distance_miles": walk.get("distance_miles", 0),
            "emoji": MODE_EMOJI["walk"], "fits": mins <= gap_minutes,
        }

    if is_transit_city(origin) or is_transit_city(destination):
        transit = get_travel_time(origin, destination, "transit", departure_iso)
        if transit and not transit.get("error"):
            mins = transit.get("duration_minutes", 999)
            return {
                "mode": "transit", "duration_minutes": mins,
                "duration_text": transit.get("duration_text", f"{mins} min"),
                "distance_miles": transit.get("distance_miles", 0),
                "emoji": MODE_EMOJI["transit"], "fits": mins <= gap_minutes,
            }

    drive = get_travel_time(origin, destination, "drive", departure_iso)
    if drive:
        mins = drive.get("duration_minutes", 999)
        return {
            "mode": "drive", "duration_minutes": mins,
            "duration_text": drive.get("duration_text", f"{mins} min"),
            "distance_miles": drive.get("distance_miles", 0),
            "emoji": MODE_EMOJI["drive"], "fits": mins <= gap_minutes,
        }

    if walk:
        mins = walk["duration_minutes"]
        return {
            "mode": "walk", "duration_minutes": mins,
            "duration_text": walk.get("duration_text", f"{mins} min"),
            "distance_miles": walk.get("distance_miles", 0),
            "emoji": MODE_EMOJI["walk"], "fits": mins <= gap_minutes,
        }
    return None


def create_travel_event(summary: str, start: str, end: str, description: str, location: str = "") -> bool:
    if not os.path.exists(CALENDAR_WRAPPER):
        log("Calendar wrapper not found")
        return False
    args = [
        "python3", CALENDAR_WRAPPER, "create",
        "--summary", summary, "--start", start, "--end", end,
        "--description", description, "--free",
    ]
    if location:
        args.extend(["--location", location])
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            log(f"Failed to create event: {result.stderr}")
            return False
        return True
    except Exception as e:
        log(f"Failed to create event: {e}")
        return False


def process_needs_travel(item: dict, classify_result: dict | None) -> bool:
    """Create a travel event for an item that needs travel. Returns True if created."""
    metadata = item.get("metadata", {})
    event_a = metadata.get("event_a", {})
    event_b = metadata.get("event_b", {})
    travel = metadata.get("travel")
    gap_minutes = metadata.get("gap_minutes", 0)

    a_loc = event_a.get("location", "")
    b_loc = event_b.get("location", "")

    # If classify resolved locations, use those and compute travel
    if classify_result:
        inferred_a = classify_result.get("inferred_location_a")
        inferred_b = classify_result.get("inferred_location_b")
        if inferred_a:
            a_loc = inferred_a
        if inferred_b:
            b_loc = inferred_b

    if not a_loc or not b_loc:
        log(f"Missing locations for {item.get('id', '?')}")
        return False

    # If no travel data from gather, compute it now
    if not travel:
        a_end = event_a.get("end", {})
        departure_iso = a_end.get("dateTime", "")
        travel = choose_travel_mode(a_loc, b_loc, gap_minutes, departure_iso or None)
        if not travel:
            log(f"Maps API returned no results for {a_loc} \u2192 {b_loc}")
            return False

        if not travel["fits"]:
            # Travel doesn't fit — flag as conflict instead
            a_summary = event_a.get("summary", "?")
            b_summary = event_b.get("summary", "?")
            print(
                f"CONFLICT: {a_summary} \u2192 {b_summary}: "
                f"need {travel['duration_minutes']} min but only {gap_minutes} min gap",
                file=sys.stderr,
            )
            return False

    emoji = travel.get("emoji", MODE_EMOJI.get(travel.get("mode", "drive"), "\U0001f697"))
    mode = travel.get("mode", "drive")
    duration_text = travel.get("duration_text", "")
    distance_miles = travel.get("distance_miles", 0)

    a_short = a_loc.split(",")[0] if "," in a_loc else a_loc
    b_short = b_loc.split(",")[0] if "," in b_loc else b_loc

    a_end_dt = event_a.get("end", {}).get("dateTime", "")
    b_start_dt = event_b.get("start", {}).get("dateTime", "")

    if not a_end_dt or not b_start_dt:
        log(f"Missing start/end times for {item.get('id', '?')}")
        return False

    summary = f"{emoji} Travel: {a_short} \u2192 {b_short}"
    description = f"[claw/travel] {mode} | {duration_text} | {distance_miles} mi"
    location_str = f"{a_short} \u2192 {b_short}"

    return create_travel_event(summary, a_end_dt, b_start_dt, description, location_str)


def main() -> None:
    stdin_data = sys.stdin.read().strip()
    if not stdin_data:
        log("No input on stdin")
        return

    # Parse classify output — may be JSON array or text containing JSON
    try:
        classify_results = json.loads(stdin_data)
    except json.JSONDecodeError:
        match = re.search(r'\[[\s\S]*\]', stdin_data)
        if not match:
            log("No JSON array found in classify output")
            return
        try:
            classify_results = json.loads(match.group())
        except json.JSONDecodeError:
            log("Failed to parse extracted JSON array")
            return

    if not isinstance(classify_results, list):
        log("Expected JSON array")
        return

    # Build lookup of classify decisions by item id
    classify_by_id: dict[str, dict] = {}
    for cr in classify_results:
        item_id = cr.get("id", "")
        if item_id:
            classify_by_id[item_id] = cr

    events_created = 0
    conflicts = 0

    for cr in classify_results:
        item_id = cr.get("id", "")
        classification = cr.get("classification", "")

        if classification in ("no-travel", "already-exists", "needs-attention"):
            continue

        if classification == "needs-travel":
            # Build a minimal item from classify result for process_needs_travel
            item = {
                "id": item_id,
                "metadata": cr.get("metadata", {}),
            }

            # The classify result itself may have metadata from the original items
            # or it may just have inferred_location fields
            if process_needs_travel(item, cr):
                events_created += 1
                log(f"Created travel event for {item_id}")

        elif classification == "impossible":
            metadata = cr.get("metadata", {})
            event_a = metadata.get("event_a", {})
            event_b = metadata.get("event_b", {})
            a_summary = event_a.get("summary", "?")
            b_summary = event_b.get("summary", "?")
            gap = metadata.get("gap_minutes", 0)
            travel = metadata.get("travel", {})
            travel_mins = travel.get("duration_minutes", "?")

            conflict_msg = (
                f"Back-to-back conflict: {a_summary} \u2192 {b_summary}. "
                f"Gap: {gap} min, travel needs {travel_mins} min."
            )
            print(f"CONFLICT: {conflict_msg}", file=sys.stderr)
            conflicts += 1

    if events_created > 0 or conflicts > 0:
        log(f"Created {events_created} travel events, flagged {conflicts} conflicts")


if __name__ == "__main__":
    main()
