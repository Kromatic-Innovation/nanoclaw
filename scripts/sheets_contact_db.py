#!/usr/bin/env python3
"""
Google Sheets-backed contact database for the email triage pipeline.

Reads contact tags, allowed actions, programmatic rules, and drafting context
from a Google Sheet. Writes triage decisions to a log sheet for retrospectives.

Commands:
  lookup <email>          — Look up contact by email, return tags + allowed actions
  log-triage <json>       — Append a triage decision to the Triage Log sheet
  get-rules               — Return all programmatic rules as JSON
  suggest-rule <json>     — Append a rule suggestion to the Triage Log
  ensure-labels           — Create claw/* Gmail labels if they don't exist

Credentials: Uses the same Google OAuth credentials as gmail_wrapper.py
(~/.openclaw/secrets/google-gmail.json or 1Password).

Environment overrides:
  SHEETS_SPREADSHEET_ID   — Google Sheets spreadsheet ID
  GMAIL_CREDS_FILE        — Path to credentials JSON
  GMAIL_1PASSWORD_ITEM    — 1Password item title/ID
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
from fnmatch import fnmatch

SPREADSHEET_ID = os.environ.get("SHEETS_SPREADSHEET_ID", "")
CREDS_FILE = os.path.expanduser(
    os.environ.get("GMAIL_CREDS_FILE", "~/.openclaw/secrets/google-gmail.json")
)
ITEM_TITLE = os.environ.get(
    "GMAIL_1PASSWORD_ITEM", ""
)
TOKEN_URL = "https://oauth2.googleapis.com/token"
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"

# Sheet tab names
TAB_CONTACTS = "Email Contacts"
TAB_TAG_RULES = "Tag Rules"
TAB_TRIAGE_LOG = "Triage Log"
TAB_RULES = "Programmatic Rules"


def log(message: str) -> None:
    print(f"[sheets-contact-db] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Credential loading (duplicated from gmail_wrapper for independence)
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
        except RuntimeError:
            raise RuntimeError(f"Failed to read 1Password item: {first_error}")
        wanted = item_title.strip().lower()
        exact = next(
            (i for i in items if (i.get("title") or "").strip().lower() == wanted),
            None,
        )
        partial = next(
            (i for i in items if wanted in (i.get("title") or "").strip().lower()),
            None,
        )
        match = exact or partial
        if not match:
            raise RuntimeError(f"Failed to read 1Password item: {first_error}")
        raw = _op_run(["op", "item", "get", match["id"], "--format", "json"])
        return json.loads(raw)


def _get_field(item: dict, wanted: str) -> str | None:
    for field in item.get("fields", []):
        candidates = [
            field.get("id"),
            field.get("label"),
            field.get("title"),
            field.get("purpose"),
        ]
        if any((c or "").strip().lower() == wanted.lower() for c in candidates):
            value = field.get("value")
            if value:
                return str(value)
    return None


def load_creds() -> tuple[str, str, str]:
    if os.path.exists(CREDS_FILE):
        with open(CREDS_FILE) as f:
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
            raise RuntimeError(
                f"Missing field(s) in creds file '{CREDS_FILE}': {', '.join(missing)}"
            )
        return client_id, client_secret, refresh_token

    item = _op_item_json(ITEM_TITLE)
    client_id = _get_field(item, "client_id")
    client_secret = _get_field(item, "client_secret")
    refresh_token = _get_field(item, "refresh_token")
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
        raise RuntimeError(
            f"Missing field(s) in 1Password item '{ITEM_TITLE}': {', '.join(missing)}"
        )
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
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {err_body}")
    return data["access_token"]


# ---------------------------------------------------------------------------
# Google Sheets API helpers
# ---------------------------------------------------------------------------


def sheets_request(
    method: str,
    path: str,
    params: dict | None = None,
    payload: dict | None = None,
) -> dict | list:
    token = get_access_token()
    url = f"{SHEETS_API}/{SPREADSHEET_ID}{path}"
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
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        if e.code == 403 and "PERMISSION_DENIED" in err_body:
            log(
                "Sheets API returned 403. The OAuth token may not include the "
                "spreadsheets scope. Re-authorize with: "
                "https://www.googleapis.com/auth/spreadsheets"
            )
        raise RuntimeError(f"Sheets API error ({e.code}): {err_body}")


def read_sheet(tab: str) -> list[list[str]]:
    """Read all rows from a sheet tab. Returns list of rows (each a list of strings)."""
    encoded_tab = urllib.parse.quote(tab)
    result = sheets_request("GET", f"/values/{encoded_tab}")
    return result.get("values", [])


def append_rows(tab: str, rows: list[list[str]]) -> None:
    """Append rows to a sheet tab."""
    encoded_tab = urllib.parse.quote(tab)
    sheets_request(
        "POST",
        f"/values/{encoded_tab}:append",
        params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
        payload={"values": rows},
    )


# ---------------------------------------------------------------------------
# Contact lookup
# ---------------------------------------------------------------------------


def load_tag_rules() -> dict[str, list[str]]:
    """Load tag → allowed_actions mapping from the Tag Rules sheet."""
    rows = read_sheet(TAB_TAG_RULES)
    if len(rows) < 2:
        return {}
    # Skip header row
    rules: dict[str, list[str]] = {}
    for row in rows[1:]:
        if len(row) >= 2:
            tag = row[0].strip().lower()
            actions = [a.strip() for a in row[1].split(",") if a.strip()]
            rules[tag] = actions
    return rules


def lookup_contact(email_addr: str) -> dict:
    """Look up a contact by email. Returns tags, allowed_actions, drafting_context.

    Supports exact email match and domain wildcard patterns (e.g., *@acme.com).
    """
    rows = read_sheet(TAB_CONTACTS)
    if len(rows) < 2:
        return _unknown_contact(email_addr)

    # Parse header
    header = [h.strip().lower() for h in rows[0]]
    email_col = header.index("email") if "email" in header else 0
    tags_col = header.index("tags") if "tags" in header else 2
    actions_col = header.index("allowed_actions") if "allowed_actions" in header else 3
    context_col = header.index("drafting_context") if "drafting_context" in header else 4
    name_col = header.index("name") if "name" in header else 1

    email_lower = email_addr.strip().lower()
    tag_rules = load_tag_rules()

    for row in rows[1:]:
        if len(row) <= email_col:
            continue
        pattern = row[email_col].strip().lower()
        if not pattern:
            continue

        # Match exact email or glob pattern (e.g., *@acme.com)
        if pattern == email_lower or fnmatch(email_lower, pattern):
            tags = _get_col(row, tags_col)
            tag_list = [t.strip().lower() for t in tags.split(",") if t.strip()]

            # Resolve allowed_actions: explicit column takes precedence, else derive from tags
            explicit_actions = _get_col(row, actions_col)
            if explicit_actions:
                action_list = [a.strip() for a in explicit_actions.split(",") if a.strip()]
            else:
                action_list = _resolve_actions_from_tags(tag_list, tag_rules)

            return {
                "email": email_addr,
                "name": _get_col(row, name_col),
                "tags": tag_list,
                "allowed_actions": action_list,
                "drafting_context": _get_col(row, context_col),
                "matched": True,
            }

    return _unknown_contact(email_addr)


def _get_col(row: list[str], idx: int) -> str:
    return row[idx].strip() if idx < len(row) else ""


def _unknown_contact(email_addr: str) -> dict:
    return {
        "email": email_addr,
        "name": "",
        "tags": ["unknown"],
        "allowed_actions": ["escalate"],
        "drafting_context": "",
        "matched": False,
    }


def _resolve_actions_from_tags(
    tags: list[str], tag_rules: dict[str, list[str]]
) -> list[str]:
    """Union of allowed actions for all tags."""
    actions: set[str] = set()
    for tag in tags:
        if tag in tag_rules:
            actions.update(tag_rules[tag])
    return sorted(actions) if actions else ["escalate"]


# ---------------------------------------------------------------------------
# Programmatic rules
# ---------------------------------------------------------------------------


def get_programmatic_rules() -> list[dict]:
    """Load all programmatic rules from the sheet."""
    rows = read_sheet(TAB_RULES)
    if len(rows) < 2:
        return []
    header = [h.strip().lower() for h in rows[0]]
    rules = []
    for row in rows[1:]:
        rule = {}
        for i, col in enumerate(header):
            rule[col] = row[i].strip() if i < len(row) else ""
        if rule.get("condition"):
            rules.append(rule)
    return rules


def apply_programmatic_rules(
    email_from: str, subject: str, rules: list[dict]
) -> str | None:
    """Apply programmatic rules to an email. Returns category or None."""
    email_lower = email_from.strip().lower()
    domain = email_lower.split("@")[-1] if "@" in email_lower else ""
    subject_lower = subject.lower()

    for rule in rules:
        condition = rule.get("condition", "")
        action = rule.get("action", "")

        if condition.startswith("from_domain:"):
            pattern = condition[len("from_domain:"):].strip().lower()
            if domain == pattern or fnmatch(domain, pattern):
                return action

        elif condition.startswith("from_email:"):
            pattern = condition[len("from_email:"):].strip().lower()
            if email_lower == pattern or fnmatch(email_lower, pattern):
                return action

        elif condition.startswith("subject_contains:"):
            keyword = condition[len("subject_contains:"):].strip().lower()
            if keyword in subject_lower:
                return action

        elif condition.startswith("has_unsubscribe:"):
            # This would need header access — skip for now, handled in Tier 1
            pass

    return None


# ---------------------------------------------------------------------------
# List / add / update contacts
# ---------------------------------------------------------------------------


def list_contacts() -> list[dict]:
    """List all contacts from the Email Contacts sheet."""
    rows = read_sheet(TAB_CONTACTS)
    if len(rows) < 2:
        return []
    header = [h.strip().lower() for h in rows[0]]
    contacts = []
    for row in rows[1:]:
        contact = {}
        for i, col in enumerate(header):
            contact[col] = row[i].strip() if i < len(row) else ""
        if contact.get("email"):
            contacts.append(contact)
    return contacts


def add_contact(data: dict) -> dict:
    """Add a new contact row to the Email Contacts sheet."""
    row = [
        data.get("email", ""),
        data.get("name", ""),
        data.get("tags", ""),
        data.get("allowed_actions", ""),
        data.get("drafting_context", ""),
        data.get("notes", ""),
    ]
    append_rows(TAB_CONTACTS, [row])
    return {"status": "added", "email": data.get("email", "")}


def update_contact(email_addr: str, data: dict) -> dict:
    """Update an existing contact row by email. Rewrites the full sheet."""
    rows = read_sheet(TAB_CONTACTS)
    if len(rows) < 2:
        return {"status": "not_found", "email": email_addr}

    header = [h.strip().lower() for h in rows[0]]
    email_col = header.index("email") if "email" in header else 0
    email_lower = email_addr.strip().lower()
    found = False

    for i, row in enumerate(rows[1:], start=1):
        if len(row) > email_col and row[email_col].strip().lower() == email_lower:
            # Update fields that are provided
            field_map = {
                "name": header.index("name") if "name" in header else 1,
                "tags": header.index("tags") if "tags" in header else 2,
                "allowed_actions": header.index("allowed_actions") if "allowed_actions" in header else 3,
                "drafting_context": header.index("drafting_context") if "drafting_context" in header else 4,
                "notes": header.index("notes") if "notes" in header else 5,
            }
            for field, col_idx in field_map.items():
                if field in data:
                    while len(rows[i]) <= col_idx:
                        rows[i].append("")
                    rows[i][col_idx] = data[field]
            found = True
            break

    if not found:
        return {"status": "not_found", "email": email_addr}

    # Write back entire sheet
    encoded_tab = urllib.parse.quote(TAB_CONTACTS)
    sheets_request(
        "PUT",
        f"/values/{encoded_tab}",
        params={"valueInputOption": "USER_ENTERED"},
        payload={"values": rows},
    )
    return {"status": "updated", "email": email_addr}


# ---------------------------------------------------------------------------
# Tag rules management
# ---------------------------------------------------------------------------


def list_tag_rules_full() -> list[dict]:
    """List all tag rules with full details."""
    rows = read_sheet(TAB_TAG_RULES)
    if len(rows) < 2:
        return []
    header = [h.strip().lower() for h in rows[0]]
    rules = []
    for row in rows[1:]:
        rule = {}
        for i, col in enumerate(header):
            rule[col] = row[i].strip() if i < len(row) else ""
        if rule.get("tag"):
            rules.append(rule)
    return rules


def add_tag_rule(data: dict) -> dict:
    """Add a new tag rule row to the Tag Rules sheet."""
    row = [
        data.get("tag", ""),
        data.get("allowed_actions", ""),
        data.get("description", ""),
    ]
    append_rows(TAB_TAG_RULES, [row])
    return {"status": "added", "tag": data.get("tag", "")}


# ---------------------------------------------------------------------------
# Programmatic rules management
# ---------------------------------------------------------------------------


def add_programmatic_rule(data: dict) -> dict:
    """Add a new programmatic rule to the Programmatic Rules sheet."""
    # Auto-generate rule_id
    existing = get_programmatic_rules()
    next_id = len(existing) + 1
    row = [
        data.get("rule_id", f"rule-{next_id}"),
        data.get("condition", ""),
        data.get("action", ""),
        data.get("description", ""),
    ]
    append_rows(TAB_RULES, [row])
    return {"status": "added", "rule_id": row[0]}


# ---------------------------------------------------------------------------
# Triage log reading
# ---------------------------------------------------------------------------


def get_triage_log(limit: int = 20) -> list[dict]:
    """Read recent triage log entries."""
    rows = read_sheet(TAB_TRIAGE_LOG)
    if len(rows) < 2:
        return []
    header = [h.strip().lower() for h in rows[0]]
    entries = []
    for row in rows[1:]:
        entry = {}
        for i, col in enumerate(header):
            entry[col] = row[i].strip() if i < len(row) else ""
        entries.append(entry)
    # Return most recent entries
    return entries[-limit:]


# ---------------------------------------------------------------------------
# Triage logging
# ---------------------------------------------------------------------------


def log_triage(entry: dict) -> None:
    """Append a triage decision to the Triage Log sheet."""
    now = datetime.now(timezone.utc).isoformat()
    row = [
        entry.get("timestamp", now),
        entry.get("email_id", ""),
        entry.get("from", ""),
        entry.get("subject", ""),
        entry.get("category", ""),
        entry.get("action_taken", ""),
        str(entry.get("confidence", "")),
        entry.get("reasoning", ""),
        entry.get("rule_matched", ""),
    ]
    append_rows(TAB_TRIAGE_LOG, [row])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Google Sheets contact database for email triage"
    )
    sub = parser.add_subparsers(dest="command")

    # lookup
    p_lookup = sub.add_parser("lookup", help="Look up a contact by email")
    p_lookup.add_argument("email", help="Email address to look up")

    # log-triage
    p_log = sub.add_parser("log-triage", help="Log a triage decision")
    p_log.add_argument("json_data", help="JSON string with triage entry")

    # get-rules
    sub.add_parser("get-rules", help="Get all programmatic rules")

    # suggest-rule
    p_suggest = sub.add_parser("suggest-rule", help="Log a rule suggestion")
    p_suggest.add_argument("json_data", help="JSON with rule suggestion")

    # match-rules
    p_match = sub.add_parser(
        "match-rules", help="Apply programmatic rules to an email"
    )
    p_match.add_argument("--from", dest="from_email", required=True)
    p_match.add_argument("--subject", default="")

    # list-contacts
    sub.add_parser("list-contacts", help="List all contacts")

    # add-contact
    p_add_contact = sub.add_parser("add-contact", help="Add a new contact")
    p_add_contact.add_argument("json_data", help="JSON with contact fields")

    # update-contact
    p_update_contact = sub.add_parser("update-contact", help="Update a contact")
    p_update_contact.add_argument("email", help="Email of contact to update")
    p_update_contact.add_argument("json_data", help="JSON with fields to update")

    # list-tag-rules
    sub.add_parser("list-tag-rules", help="List all tag rules")

    # add-tag-rule
    p_add_tag = sub.add_parser("add-tag-rule", help="Add a tag rule")
    p_add_tag.add_argument("json_data", help="JSON with tag rule fields")

    # list-programmatic-rules (alias for get-rules)
    sub.add_parser("list-programmatic-rules", help="List all programmatic rules")

    # add-programmatic-rule
    p_add_rule = sub.add_parser("add-programmatic-rule", help="Add a programmatic rule")
    p_add_rule.add_argument("json_data", help="JSON with rule fields")

    # get-triage-log
    p_triage_log = sub.add_parser("get-triage-log", help="Get recent triage log")
    p_triage_log.add_argument("--limit", type=int, default=20, help="Max entries")

    args = parser.parse_args()

    if not SPREADSHEET_ID:
        print(
            json.dumps({"error": "SHEETS_SPREADSHEET_ID not set"}), file=sys.stderr
        )
        sys.exit(1)

    if args.command == "lookup":
        result = lookup_contact(args.email)
        json.dump(result, sys.stdout)

    elif args.command == "log-triage":
        entry = json.loads(args.json_data)
        log_triage(entry)
        print(json.dumps({"status": "logged"}))

    elif args.command == "get-rules":
        rules = get_programmatic_rules()
        json.dump(rules, sys.stdout)

    elif args.command == "suggest-rule":
        suggestion = json.loads(args.json_data)
        log_triage(
            {
                "category": "rule-suggestion",
                "reasoning": json.dumps(suggestion),
                "action_taken": "suggested",
            }
        )
        print(json.dumps({"status": "suggestion logged"}))

    elif args.command == "match-rules":
        rules = get_programmatic_rules()
        result = apply_programmatic_rules(
            args.from_email, args.subject, rules
        )
        json.dump({"category": result}, sys.stdout)

    elif args.command == "list-contacts":
        contacts = list_contacts()
        json.dump(contacts, sys.stdout)

    elif args.command == "add-contact":
        data = json.loads(args.json_data)
        result = add_contact(data)
        json.dump(result, sys.stdout)

    elif args.command == "update-contact":
        data = json.loads(args.json_data)
        result = update_contact(args.email, data)
        json.dump(result, sys.stdout)

    elif args.command == "list-tag-rules":
        rules = list_tag_rules_full()
        json.dump(rules, sys.stdout)

    elif args.command == "add-tag-rule":
        data = json.loads(args.json_data)
        result = add_tag_rule(data)
        json.dump(result, sys.stdout)

    elif args.command == "list-programmatic-rules":
        rules = get_programmatic_rules()
        json.dump(rules, sys.stdout)

    elif args.command == "add-programmatic-rule":
        data = json.loads(args.json_data)
        result = add_programmatic_rule(data)
        json.dump(result, sys.stdout)

    elif args.command == "get-triage-log":
        entries = get_triage_log(args.limit)
        json.dump(entries, sys.stdout)

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
