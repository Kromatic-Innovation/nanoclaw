#!/usr/bin/env python3
"""Minimal Google Maps wrapper (Routes API).

Capabilities:
- directions: compute route between origin and destination
- distance: get travel time and distance only

Uses the same Google OAuth credentials as calendar/gmail wrappers.
Secrets loaded from creds file or 1Password.

Examples:
  python3 scripts/google_maps_wrapper.py directions --origin "123 Main St, NYC" --destination "456 Oak Ave, Brooklyn"
  python3 scripts/google_maps_wrapper.py directions --origin "123 Main St" --destination "456 Oak Ave" --mode transit
  python3 scripts/google_maps_wrapper.py distance --origin "Home address" --destination "Office address"
  python3 scripts/google_maps_wrapper.py distance --origin "Home" --destination "SFO" --departure "2026-04-01T08:00:00-04:00"
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ITEM_TITLE = os.environ.get("GOOGLE_1PASSWORD_ITEM", "6ww6jmxamdxreo2pc2xpujawsq")
CREDS_FILES = {
    "1": os.path.expanduser(os.environ.get("GOOGLE_CREDS_FILE", "~/.openclaw/secrets/google-gmail.json")),
    "2": os.path.expanduser("~/.openclaw/secrets/google-gmail-2.json"),
}
CREDS_FILE = CREDS_FILES["1"]  # default for backwards compat
TOKEN_URL = "https://oauth2.googleapis.com/token"
ROUTES_API = "https://routes.googleapis.com"

# Module-level account override (set by --account flag before commands run)
_active_account: str = "1"


def die(message: str, code: int = 1) -> int:
    print(json.dumps({"error": message}), file=sys.stdout)
    return code


def op_run(args: list[str]) -> str:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)
    except FileNotFoundError:
        raise RuntimeError("1Password CLI (`op`) not found.")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.output.strip())


def op_item_json(item_title: str) -> dict:
    try:
        raw = op_run(["op", "item", "get", item_title, "--format", "json"])
        return json.loads(raw)
    except RuntimeError as first_error:
        try:
            items = json.loads(op_run(["op", "item", "list", "--format", "json"]))
        except RuntimeError:
            raise RuntimeError(f"Failed to read 1Password item: {first_error}")
        wanted = item_title.strip().lower()
        exact = next((i for i in items if (i.get("title") or "").strip().lower() == wanted), None)
        partial = next((i for i in items if wanted in (i.get("title") or "").strip().lower()), None)
        match = exact or partial
        if not match:
            raise RuntimeError(f"Failed to read 1Password item: {first_error}")
        raw = op_run(["op", "item", "get", match["id"], "--format", "json"])
        return json.loads(raw)


def get_field(item: dict, wanted: str) -> str | None:
    for field in item.get("fields", []):
        candidates = [field.get("id"), field.get("label"), field.get("title"), field.get("purpose")]
        if any((c or "").strip().lower() == wanted.lower() for c in candidates):
            value = field.get("value")
            if value:
                return str(value)
    return None


def load_creds() -> tuple[str, str, str]:
    creds_file = CREDS_FILES.get(_active_account, CREDS_FILES["1"])
    if os.path.exists(creds_file):
        with open(creds_file) as f:
            data = json.load(f)
        client_id = (data.get("client_id") or "").strip()
        client_secret = (data.get("client_secret") or "").strip()
        refresh_token = (data.get("refresh_token") or "").strip()
        missing = [n for n, v in [("client_id", client_id), ("client_secret", client_secret), ("refresh_token", refresh_token)] if not v]
        if missing:
            raise RuntimeError(f"Missing field(s) in creds file '{creds_file}': {', '.join(missing)}")
        return client_id, client_secret, refresh_token

    if _active_account != "1":
        raise RuntimeError(
            f"Creds file not found for account {_active_account}: {creds_file}. "
            "Run google_reauth.py --account 2 to set up the second account."
        )

    item = op_item_json(ITEM_TITLE)
    client_id = get_field(item, "client_id")
    client_secret = get_field(item, "client_secret")
    refresh_token = get_field(item, "refresh_token")
    missing = [n for n, v in [("client_id", client_id), ("client_secret", client_secret), ("refresh_token", refresh_token)] if not v]
    if missing:
        raise RuntimeError(f"Missing field(s) in 1Password item '{ITEM_TITLE}': {', '.join(missing)}")
    return client_id, client_secret, refresh_token


def get_access_token() -> str:
    client_id, client_secret, refresh_token = load_creds()
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {err_body}")
    return data["access_token"]


TRAVEL_MODE_MAP = {
    "drive": "DRIVE",
    "transit": "TRANSIT",
    "walk": "WALK",
    "bicycle": "BICYCLE",
    "two_wheeler": "TWO_WHEELER",
}


def compute_routes(
    origin: str,
    destination: str,
    mode: str = "drive",
    departure_time: str | None = None,
) -> dict:
    """Call the Routes API computeRoutes endpoint."""
    token = get_access_token()
    travel_mode = TRAVEL_MODE_MAP.get(mode.lower(), "DRIVE")

    payload: dict = {
        "origin": {"address": origin},
        "destination": {"address": destination},
        "travelMode": travel_mode,
        "computeAlternativeRoutes": False,
        "languageCode": "en-US",
        "units": "IMPERIAL",
    }

    if departure_time:
        payload["departureTime"] = departure_time

    # Request specific fields to keep response concise
    field_mask = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.distanceMeters,routes.legs.startLocation,routes.legs.endLocation,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration"

    url = f"{ROUTES_API}/directions/v2:computeRoutes"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Goog-FieldMask": field_mask,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Routes API error {e.code}: {err_body}")


def cmd_directions(args: argparse.Namespace) -> int:
    """Get full route directions."""
    try:
        result = compute_routes(
            args.origin, args.destination,
            mode=args.mode,
            departure_time=args.departure,
        )
        print(json.dumps(result, indent=2))
        return 0
    except RuntimeError as err:
        return die(str(err))


def cmd_distance(args: argparse.Namespace) -> int:
    """Get travel time and distance only."""
    try:
        result = compute_routes(
            args.origin, args.destination,
            mode=args.mode,
            departure_time=args.departure,
        )
        routes = result.get("routes", [])
        if not routes:
            print(json.dumps({"error": "No route found"}))
            return 1

        route = routes[0]
        duration_str = route.get("duration", "0s")
        distance_m = route.get("distanceMeters", 0)

        # Parse duration (e.g., "1234s" -> minutes)
        seconds = int(duration_str.rstrip("s")) if duration_str.endswith("s") else 0
        minutes = seconds // 60

        distance_km = distance_m / 1000
        distance_mi = distance_km * 0.621371

        summary = {
            "origin": args.origin,
            "destination": args.destination,
            "mode": args.mode,
            "duration_seconds": seconds,
            "duration_minutes": minutes,
            "duration_text": f"{minutes} min" if minutes < 60 else f"{minutes // 60}h {minutes % 60}m",
            "distance_meters": distance_m,
            "distance_miles": round(distance_mi, 1),
        }
        if args.departure:
            summary["departure_time"] = args.departure

        print(json.dumps(summary, indent=2))
        return 0
    except RuntimeError as err:
        return die(str(err))


def main() -> int:
    global _active_account
    parser = argparse.ArgumentParser(description="Minimal Google Maps wrapper (Routes API)")
    parser.add_argument(
        "--account", default="1", choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = parser.add_subparsers(dest="command")

    p_dir = sub.add_parser("directions")
    p_dir.add_argument("--origin", required=True)
    p_dir.add_argument("--destination", required=True)
    p_dir.add_argument("--mode", default="drive", choices=["drive", "transit", "walk", "bicycle"])
    p_dir.add_argument("--departure", help="ISO 8601 departure time")

    p_dist = sub.add_parser("distance")
    p_dist.add_argument("--origin", required=True)
    p_dist.add_argument("--destination", required=True)
    p_dist.add_argument("--mode", default="drive", choices=["drive", "transit", "walk", "bicycle"])
    p_dist.add_argument("--departure", help="ISO 8601 departure time")

    args = parser.parse_args()
    _active_account = getattr(args, "account", "1")
    if not args.command:
        parser.print_help()
        return 1

    return {"directions": cmd_directions, "distance": cmd_distance}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
