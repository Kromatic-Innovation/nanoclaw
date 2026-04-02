#!/usr/bin/env python3
"""Minimal Google Calendar wrapper.

Capabilities:
- list calendars
- list events
- create events
- update events

No delete command on purpose.

Secrets are loaded from a 1Password item via `op item get ... --format json`.
Expected custom fields in the item:
- client_id
- client_secret
- refresh_token

Defaults:
- item id/title: set via GOOGLE_1PASSWORD_ITEM env var
- calendar id: primary

Examples:
  python3 scripts/google_calendar_wrapper.py calendars
  python3 scripts/google_calendar_wrapper.py list --calendar primary --days 7
  python3 scripts/google_calendar_wrapper.py create --summary 'Demo' --start '2026-03-23T10:00:00-04:00' --end '2026-03-23T10:30:00-04:00'
  python3 scripts/google_calendar_wrapper.py update --id EVENT_ID --summary 'Updated title'
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
from datetime import datetime, timedelta, timezone

ITEM_TITLE = os.environ.get("GOOGLE_1PASSWORD_ITEM", "")


def _resolve_creds_file(account: str = "1") -> str:
    """Resolve credentials file path with flexible fallback.

    Search order per account:
      1. Env var GOOGLE_CREDS_FILE (account 1) / GOOGLE_CREDS_FILE_2 (account 2)
      2. ~/.config/nanoclaw/secrets/google-gmail.json (or -2.json)
      3. ~/.openclaw/secrets/google-gmail.json (or -2.json)
    """
    suffix = "" if account == "1" else f"-{account}"
    env_key = "GOOGLE_CREDS_FILE" if account == "1" else f"GOOGLE_CREDS_FILE_{account}"
    env_val = os.environ.get(env_key)
    if env_val:
        return os.path.expanduser(env_val)

    candidates = [
        os.path.expanduser(f"~/.config/nanoclaw/secrets/google-gmail{suffix}.json"),
        os.path.expanduser(f"~/.openclaw/secrets/google-gmail{suffix}.json"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    # Return the first candidate as default (will fail gracefully later)
    return candidates[0]


CREDS_FILES = {
    "1": _resolve_creds_file("1"),
    "2": _resolve_creds_file("2"),
}
CREDS_FILE = CREDS_FILES["1"]  # default for backwards compat
DEFAULT_CALENDAR = os.environ.get("GOOGLE_CALENDAR_ID", "primary")
CAL_API = "https://www.googleapis.com/calendar/v3"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Module-level account override (set by --account flag before commands run)
_active_account: str = "1"


def die(message: str, code: int = 1) -> int:
    print(message, file=sys.stderr)
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
        missing = [
            name
            for name, value in [
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("refresh_token", refresh_token),
            ]
            if not value
        ]
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
    missing = [
        name
        for name, value in [
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
        ]
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing field(s) in 1Password item '{ITEM_TITLE}': {', '.join(missing)}")
    return client_id, client_secret, refresh_token


def get_access_token() -> str:
    client_id, client_secret, refresh_token = load_creds()
    body = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {body}")
    return data["access_token"]


def api_request(method: str, path: str, params: dict | None = None, payload: dict | None = None) -> dict:
    token = get_access_token()
    url = CAL_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Calendar API error {e.code}: {body}")


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def calendar_path(calendar_id: str, suffix: str = "") -> str:
    return f"/calendars/{urllib.parse.quote(calendar_id, safe='')}{suffix}"


def clean_event(event: dict) -> dict:
    keep = [
        "id",
        "status",
        "summary",
        "description",
        "location",
        "htmlLink",
        "created",
        "updated",
        "start",
        "end",
        "attendees",
        "organizer",
    ]
    return {k: event.get(k) for k in keep if k in event}


def cmd_calendars(_args: argparse.Namespace) -> int:
    data = api_request("GET", "/users/me/calendarList")
    out = []
    for c in data.get("items", []):
        out.append({"id": c.get("id"), "summary": c.get("summary"), "primary": c.get("primary", False)})
    print(json.dumps(out, indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    now = datetime.now(timezone.utc)
    params = {
        "singleEvents": "true",
        "orderBy": "startTime",
        "timeMin": args.time_min or iso_utc(now),
        "maxResults": args.limit,
    }
    if args.time_max:
        params["timeMax"] = args.time_max
    elif args.days:
        params["timeMax"] = iso_utc(now + timedelta(days=args.days))
    data = api_request("GET", calendar_path(args.calendar, "/events"), params=params)
    print(json.dumps([clean_event(e) for e in data.get("items", [])], indent=2))
    return 0


def event_payload(args: argparse.Namespace, base: dict | None = None) -> dict:
    payload = dict(base or {})
    if args.summary is not None:
        payload["summary"] = args.summary
    if args.description is not None:
        payload["description"] = args.description
    if args.location is not None:
        payload["location"] = args.location
    if args.start is not None:
        payload["start"] = {"dateTime": args.start}
    if args.end is not None:
        payload["end"] = {"dateTime": args.end}
    if getattr(args, "free", False):
        payload["transparency"] = "transparent"
    elif getattr(args, "busy", False):
        payload["transparency"] = "opaque"
    return payload


def cmd_create(args: argparse.Namespace) -> int:
    if not args.start or not args.end or not args.summary:
        return die("create requires --summary, --start, and --end")
    payload = event_payload(args)
    data = api_request("POST", calendar_path(args.calendar, "/events"), payload=payload)
    print(json.dumps(clean_event(data), indent=2))
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    original = api_request("GET", calendar_path(args.calendar, f"/events/{urllib.parse.quote(args.id, safe='')}"))
    payload = event_payload(args, base=original)
    data = api_request("PUT", calendar_path(args.calendar, f"/events/{urllib.parse.quote(args.id, safe='')}"), payload=payload)
    print(json.dumps(clean_event(data), indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Minimal Google Calendar wrapper")
    p.add_argument(
        "--account", default="1", choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("calendars")

    p_list = sub.add_parser("list")
    p_list.add_argument("--calendar", default=DEFAULT_CALENDAR)
    p_list.add_argument("--days", type=int, default=7)
    p_list.add_argument("--time-min")
    p_list.add_argument("--time-max")
    p_list.add_argument("--limit", type=int, default=25)

    p_create = sub.add_parser("create")
    p_create.add_argument("--calendar", default=DEFAULT_CALENDAR)
    p_create.add_argument("--summary")
    p_create.add_argument("--description")
    p_create.add_argument("--location")
    p_create.add_argument("--start")
    p_create.add_argument("--end")
    p_create.add_argument("--free", action="store_true", help="Show as Free")
    p_create.add_argument("--busy", action="store_true", help="Show as Busy (default)")

    p_update = sub.add_parser("update")
    p_update.add_argument("--calendar", default=DEFAULT_CALENDAR)
    p_update.add_argument("--id", required=True)
    p_update.add_argument("--summary")
    p_update.add_argument("--description")
    p_update.add_argument("--location")
    p_update.add_argument("--start")
    p_update.add_argument("--end")
    p_update.add_argument("--free", action="store_true", help="Show as Free")
    p_update.add_argument("--busy", action="store_true", help="Show as Busy")

    return p


def main() -> int:
    global _active_account
    args = parser().parse_args()
    _active_account = getattr(args, "account", "1")
    try:
        if args.command == "calendars":
            return cmd_calendars(args)
        if args.command == "list":
            return cmd_list(args)
        if args.command == "create":
            return cmd_create(args)
        if args.command == "update":
            return cmd_update(args)
        return die("Unknown command")
    except Exception as e:
        return die(str(e))


if __name__ == "__main__":
    raise SystemExit(main())
