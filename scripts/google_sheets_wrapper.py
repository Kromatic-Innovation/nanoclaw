#!/usr/bin/env python3
"""General-purpose Google Sheets wrapper.

Capabilities:
  create         — Create a new spreadsheet
  read           — Read a range of cells
  write          — Write data to a range
  append         — Append rows to a sheet tab
  list-sheets    — List all sheet tabs in a spreadsheet
  add-sheet      — Add a new sheet tab

Uses the same Google OAuth credentials as gmail/calendar wrappers.
Secrets loaded from creds file or 1Password.

Examples:
  python3 scripts/google_sheets_wrapper.py create --title "Weekly Report"
  python3 scripts/google_sheets_wrapper.py read --spreadsheet-id <ID> --range "Sheet1!A1:C10"
  python3 scripts/google_sheets_wrapper.py write --spreadsheet-id <ID> --range "Sheet1!A1" --data '[["Name","Score"],["Alice",95]]'
  python3 scripts/google_sheets_wrapper.py append --spreadsheet-id <ID> --sheet "Sheet1" --data '[["Bob",88]]'
  python3 scripts/google_sheets_wrapper.py list-sheets --spreadsheet-id <ID>
  python3 scripts/google_sheets_wrapper.py add-sheet --spreadsheet-id <ID> --title "Q2 Data"
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

CREDS_FILE = os.path.expanduser(
    os.environ.get("GMAIL_CREDS_FILE", "~/.openclaw/secrets/google-gmail.json")
)
ITEM_TITLE = os.environ.get(
    "GMAIL_1PASSWORD_ITEM", "6ww6jmxamdxreo2pc2xpujawsq"
)
TOKEN_URL = "https://oauth2.googleapis.com/token"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"


def log(message: str) -> None:
    print(f"[google-sheets-wrapper] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Credential loading (shared pattern with other wrappers)
# ---------------------------------------------------------------------------


def _op_run(args: list[str]) -> str:
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)
    except FileNotFoundError:
        raise RuntimeError("1Password CLI (`op`) not found.")
    except subprocess.CalledProcessError as e:
        raise RuntimeError(e.output.strip())


def _op_item_json(item_title: str) -> dict:
    try:
        raw = _op_run(["op", "item", "get", item_title, "--format", "json"])
        return json.loads(raw)
    except RuntimeError as first_error:
        try:
            items = json.loads(
                _op_run(["op", "item", "list", "--format", "json"])
            )
            match = next(
                (i for i in items if i.get("title") == item_title), None
            )
            if match:
                raw = _op_run(
                    ["op", "item", "get", match["id"], "--format", "json"]
                )
                return json.loads(raw)
        except Exception:
            pass
        raise first_error


def _op_field(item: dict, label: str) -> str:
    for f in item.get("fields", []):
        if f.get("label") == label or f.get("id") == label:
            return f.get("value", "")
    raise RuntimeError(f"Field '{label}' not found in 1Password item")


def load_creds() -> tuple[str, str, str]:
    """Load OAuth credentials. Returns (client_id, client_secret, refresh_token)."""
    if os.path.exists(CREDS_FILE):
        with open(CREDS_FILE) as f:
            creds = json.load(f)
        return (
            creds["client_id"],
            creds["client_secret"],
            creds["refresh_token"],
        )

    log("Creds file not found, trying 1Password...")
    item = _op_item_json(ITEM_TITLE)
    return (
        _op_field(item, "client_id"),
        _op_field(item, "client_secret"),
        _op_field(item, "refresh_token"),
    )


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
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {err_body}")
    return data["access_token"]


# ---------------------------------------------------------------------------
# Google Sheets API helpers
# ---------------------------------------------------------------------------


def sheets_request(
    method: str,
    url: str,
    params: dict | None = None,
    payload: dict | None = None,
) -> dict | list:
    """Make an authenticated request to the Sheets API."""
    token = get_access_token()
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
            body = resp.read().decode()
            return json.loads(body) if body.strip() else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        if e.code == 403 and "PERMISSION_DENIED" in err_body:
            log(
                "Sheets API returned 403. The OAuth token may not include the "
                "spreadsheets scope. Re-authorize with: "
                "https://www.googleapis.com/auth/spreadsheets"
            )
        raise RuntimeError(f"Sheets API error ({e.code}): {err_body}")


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_create(args: argparse.Namespace) -> None:
    """Create a new spreadsheet."""
    payload: dict = {"properties": {"title": args.title}}
    if args.sheets:
        sheet_titles = [s.strip() for s in args.sheets.split(",")]
        payload["sheets"] = [
            {"properties": {"title": t}} for t in sheet_titles
        ]

    result = sheets_request("POST", SHEETS_API, payload=payload)
    output = {
        "spreadsheetId": result["spreadsheetId"],
        "spreadsheetUrl": result["spreadsheetUrl"],
        "title": result["properties"]["title"],
        "sheets": [
            s["properties"]["title"] for s in result.get("sheets", [])
        ],
    }
    print(json.dumps(output, indent=2))


def cmd_read(args: argparse.Namespace) -> None:
    """Read a range of cells."""
    encoded_range = urllib.parse.quote(args.range)
    url = f"{SHEETS_API}/{args.spreadsheet_id}/values/{encoded_range}"
    result = sheets_request("GET", url)
    output = {
        "range": result.get("range", args.range),
        "values": result.get("values", []),
    }
    print(json.dumps(output, indent=2))


def cmd_write(args: argparse.Namespace) -> None:
    """Write data to a range."""
    data = json.loads(args.data)
    encoded_range = urllib.parse.quote(args.range)
    url = f"{SHEETS_API}/{args.spreadsheet_id}/values/{encoded_range}"
    result = sheets_request(
        "PUT",
        url,
        params={"valueInputOption": args.input_option},
        payload={"values": data},
    )
    output = {
        "updatedRange": result.get("updatedRange", ""),
        "updatedRows": result.get("updatedRows", 0),
        "updatedColumns": result.get("updatedColumns", 0),
        "updatedCells": result.get("updatedCells", 0),
    }
    print(json.dumps(output, indent=2))


def cmd_append(args: argparse.Namespace) -> None:
    """Append rows to a sheet tab."""
    data = json.loads(args.data)
    encoded_sheet = urllib.parse.quote(args.sheet)
    url = f"{SHEETS_API}/{args.spreadsheet_id}/values/{encoded_sheet}:append"
    result = sheets_request(
        "POST",
        url,
        params={
            "valueInputOption": args.input_option,
            "insertDataOption": "INSERT_ROWS",
        },
        payload={"values": data},
    )
    updates = result.get("updates", {})
    output = {
        "updatedRange": updates.get("updatedRange", ""),
        "updatedRows": updates.get("updatedRows", 0),
        "updatedCells": updates.get("updatedCells", 0),
    }
    print(json.dumps(output, indent=2))


def cmd_list_sheets(args: argparse.Namespace) -> None:
    """List all sheet tabs in a spreadsheet."""
    url = f"{SHEETS_API}/{args.spreadsheet_id}"
    result = sheets_request("GET", url, params={"fields": "sheets.properties"})
    sheets = []
    for s in result.get("sheets", []):
        props = s.get("properties", {})
        sheets.append(
            {
                "sheetId": props.get("sheetId"),
                "title": props.get("title"),
                "index": props.get("index"),
                "rowCount": props.get("gridProperties", {}).get("rowCount"),
                "columnCount": props.get("gridProperties", {}).get(
                    "columnCount"
                ),
            }
        )
    print(json.dumps(sheets, indent=2))


def cmd_add_sheet(args: argparse.Namespace) -> None:
    """Add a new sheet tab to a spreadsheet."""
    url = f"{SHEETS_API}/{args.spreadsheet_id}:batchUpdate"
    payload = {
        "requests": [
            {
                "addSheet": {
                    "properties": {"title": args.title},
                }
            }
        ]
    }
    result = sheets_request("POST", url, payload=payload)
    reply = result.get("replies", [{}])[0]
    props = reply.get("addSheet", {}).get("properties", {})
    output = {
        "sheetId": props.get("sheetId"),
        "title": props.get("title"),
        "index": props.get("index"),
    }
    print(json.dumps(output, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="General-purpose Google Sheets wrapper"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # create
    p_create = sub.add_parser("create", help="Create a new spreadsheet")
    p_create.add_argument("--title", required=True, help="Spreadsheet title")
    p_create.add_argument(
        "--sheets",
        help="Comma-separated sheet tab names (default: Sheet1)",
    )

    # read
    p_read = sub.add_parser("read", help="Read a range of cells")
    p_read.add_argument("--spreadsheet-id", required=True)
    p_read.add_argument(
        "--range", required=True, help='A1 notation (e.g. "Sheet1!A1:C10")'
    )

    # write
    p_write = sub.add_parser("write", help="Write data to a range")
    p_write.add_argument("--spreadsheet-id", required=True)
    p_write.add_argument("--range", required=True, help="A1 notation for top-left cell")
    p_write.add_argument(
        "--data", required=True, help='JSON array of arrays (e.g. \'[["a","b"],[1,2]]\')'
    )
    p_write.add_argument(
        "--input-option",
        default="USER_ENTERED",
        choices=["RAW", "USER_ENTERED"],
        help="How values are interpreted (default: USER_ENTERED)",
    )

    # append
    p_append = sub.add_parser("append", help="Append rows to a sheet tab")
    p_append.add_argument("--spreadsheet-id", required=True)
    p_append.add_argument("--sheet", required=True, help="Tab name to append to")
    p_append.add_argument(
        "--data", required=True, help='JSON array of arrays'
    )
    p_append.add_argument(
        "--input-option",
        default="USER_ENTERED",
        choices=["RAW", "USER_ENTERED"],
    )

    # list-sheets
    p_list = sub.add_parser("list-sheets", help="List sheet tabs")
    p_list.add_argument("--spreadsheet-id", required=True)

    # add-sheet
    p_add = sub.add_parser("add-sheet", help="Add a new sheet tab")
    p_add.add_argument("--spreadsheet-id", required=True)
    p_add.add_argument("--title", required=True, help="New tab name")

    args = parser.parse_args()

    try:
        {
            "create": cmd_create,
            "read": cmd_read,
            "write": cmd_write,
            "append": cmd_append,
            "list-sheets": cmd_list_sheets,
            "add-sheet": cmd_add_sheet,
        }[args.command](args)
    except Exception as e:
        log(f"Error: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
