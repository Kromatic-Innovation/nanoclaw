#!/usr/bin/env python3
"""Google Contacts wrapper using the People API v1.

Capabilities:
  list           — List contacts (with optional page size)
  get            — Get a single contact by resource name
  search         — Search contacts by query string
  create         — Create a new contact
  update         — Update an existing contact (requires etag)
  delete         — Delete a contact by resource name

Uses the same Google OAuth credentials as gmail/calendar/sheets wrappers.
Supports --account flag for multi-account (1 = default, 2 = secondary).

Examples:
  python3 scripts/google_contacts_wrapper.py list
  python3 scripts/google_contacts_wrapper.py list --page-size 50
  python3 scripts/google_contacts_wrapper.py get --resource-name "people/c123456"
  python3 scripts/google_contacts_wrapper.py search --query "Alice"
  python3 scripts/google_contacts_wrapper.py create --given-name "Alice" --family-name "Smith" --email "alice@example.com"
  python3 scripts/google_contacts_wrapper.py update --resource-name "people/c123456" --etag "abc" --email "new@example.com"
  python3 scripts/google_contacts_wrapper.py delete --resource-name "people/c123456"
  python3 scripts/google_contacts_wrapper.py list --account 2
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

CREDS_FILES = {
    "1": os.path.expanduser(
        os.environ.get("GMAIL_CREDS_FILE", "~/.openclaw/secrets/google-gmail.json")
    ),
    "2": os.path.expanduser("~/.openclaw/secrets/google-gmail-2.json"),
}
ITEM_TITLE = os.environ.get(
    "GMAIL_1PASSWORD_ITEM", "6ww6jmxamdxreo2pc2xpujawsq"
)
TOKEN_URL = "https://oauth2.googleapis.com/token"
PEOPLE_API = "https://people.googleapis.com/v1"

PERSON_FIELDS = (
    "names,emailAddresses,phoneNumbers,organizations,addresses,"
    "biographies,birthdays,urls,userDefined"
)


def log(message: str) -> None:
    print(f"[google-contacts-wrapper] {message}", file=sys.stderr, flush=True)


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


def load_creds(account: str = "1") -> tuple[str, str, str]:
    """Load OAuth credentials. Returns (client_id, client_secret, refresh_token)."""
    creds_file = CREDS_FILES.get(account)
    if not creds_file:
        raise RuntimeError(f"Unknown account: {account}. Use '1' or '2'.")

    if os.path.exists(creds_file):
        with open(creds_file) as f:
            creds = json.load(f)
        return (
            creds["client_id"],
            creds["client_secret"],
            creds["refresh_token"],
        )

    if account == "1":
        log("Creds file not found, trying 1Password...")
        item = _op_item_json(ITEM_TITLE)
        return (
            _op_field(item, "client_id"),
            _op_field(item, "client_secret"),
            _op_field(item, "refresh_token"),
        )

    raise RuntimeError(
        f"Creds file not found for account {account}: {creds_file}. "
        "Run google_reauth.py --account 2 to set up the second account."
    )


def get_access_token(account: str = "1") -> str:
    client_id, client_secret, refresh_token = load_creds(account)
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
# People API helpers
# ---------------------------------------------------------------------------


def people_request(
    method: str,
    url: str,
    account: str = "1",
    params: dict | None = None,
    payload: dict | None = None,
) -> dict | list:
    """Make an authenticated request to the People API."""
    token = get_access_token(account)
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
                "People API returned 403. The OAuth token may not include the "
                "contacts scope. Re-authorize with: "
                "python3 scripts/google_reauth.py"
            )
        raise RuntimeError(f"People API error ({e.code}): {err_body}")


def _format_contact(person: dict) -> dict:
    """Extract a clean contact summary from a People API person resource."""
    names = person.get("names", [])
    emails = person.get("emailAddresses", [])
    phones = person.get("phoneNumbers", [])
    orgs = person.get("organizations", [])
    addresses = person.get("addresses", [])
    bios = person.get("biographies", [])

    return {
        "resourceName": person.get("resourceName", ""),
        "etag": person.get("etag", ""),
        "name": names[0].get("displayName", "") if names else "",
        "givenName": names[0].get("givenName", "") if names else "",
        "familyName": names[0].get("familyName", "") if names else "",
        "emails": [e.get("value", "") for e in emails],
        "phones": [p.get("value", "") for p in phones],
        "organizations": [
            {"name": o.get("name", ""), "title": o.get("title", "")}
            for o in orgs
        ],
        "addresses": [
            a.get("formattedValue", "") for a in addresses
        ],
        "notes": bios[0].get("value", "") if bios else "",
    }


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> None:
    """List contacts."""
    params = {
        "personFields": PERSON_FIELDS,
        "pageSize": str(args.page_size),
        "sortOrder": "LAST_MODIFIED_DESCENDING",
    }
    if args.page_token:
        params["pageToken"] = args.page_token

    result = people_request(
        "GET",
        f"{PEOPLE_API}/people/me/connections",
        account=args.account,
        params=params,
    )
    connections = result.get("connections", [])
    output = {
        "contacts": [_format_contact(c) for c in connections],
        "totalItems": result.get("totalItems", 0),
        "nextPageToken": result.get("nextPageToken"),
    }
    print(json.dumps(output, indent=2))


def cmd_get(args: argparse.Namespace) -> None:
    """Get a single contact."""
    result = people_request(
        "GET",
        f"{PEOPLE_API}/{args.resource_name}",
        account=args.account,
        params={"personFields": PERSON_FIELDS},
    )
    print(json.dumps(_format_contact(result), indent=2))


def cmd_search(args: argparse.Namespace) -> None:
    """Search contacts."""
    params = {
        "query": args.query,
        "readMask": PERSON_FIELDS,
        "pageSize": str(args.page_size),
    }
    result = people_request(
        "GET",
        f"{PEOPLE_API}/people:searchContacts",
        account=args.account,
        params=params,
    )
    results = result.get("results", [])
    contacts = [_format_contact(r.get("person", {})) for r in results]
    print(json.dumps({"contacts": contacts}, indent=2))


def cmd_create(args: argparse.Namespace) -> None:
    """Create a new contact."""
    person: dict = {"names": [], "emailAddresses": [], "phoneNumbers": []}

    if args.given_name or args.family_name:
        name: dict = {}
        if args.given_name:
            name["givenName"] = args.given_name
        if args.family_name:
            name["familyName"] = args.family_name
        person["names"] = [name]

    if args.email:
        person["emailAddresses"] = [{"value": args.email}]

    if args.phone:
        person["phoneNumbers"] = [{"value": args.phone}]

    if args.organization:
        org: dict = {"name": args.organization}
        if args.title:
            org["title"] = args.title
        person["organizations"] = [org]

    if args.notes:
        person["biographies"] = [{"value": args.notes}]

    result = people_request(
        "POST",
        f"{PEOPLE_API}/people:createContact",
        account=args.account,
        payload=person,
    )
    print(json.dumps(_format_contact(result), indent=2))


def cmd_update(args: argparse.Namespace) -> None:
    """Update an existing contact."""
    update_fields = []
    person: dict = {}

    if args.given_name is not None or args.family_name is not None:
        name: dict = {}
        if args.given_name is not None:
            name["givenName"] = args.given_name
        if args.family_name is not None:
            name["familyName"] = args.family_name
        person["names"] = [name]
        update_fields.append("names")

    if args.email is not None:
        person["emailAddresses"] = [{"value": args.email}]
        update_fields.append("emailAddresses")

    if args.phone is not None:
        person["phoneNumbers"] = [{"value": args.phone}]
        update_fields.append("phoneNumbers")

    if args.organization is not None:
        org: dict = {"name": args.organization}
        if args.title is not None:
            org["title"] = args.title
        person["organizations"] = [org]
        update_fields.append("organizations")

    if args.notes is not None:
        person["biographies"] = [{"value": args.notes}]
        update_fields.append("biographies")

    if not update_fields:
        raise RuntimeError("No fields to update. Provide at least one field.")

    person["etag"] = args.etag

    result = people_request(
        "PATCH",
        f"{PEOPLE_API}/{args.resource_name}:updateContact",
        account=args.account,
        params={
            "updatePersonFields": ",".join(update_fields),
            "personFields": PERSON_FIELDS,
        },
        payload=person,
    )
    print(json.dumps(_format_contact(result), indent=2))


def cmd_delete(args: argparse.Namespace) -> None:
    """Delete a contact."""
    people_request(
        "DELETE",
        f"{PEOPLE_API}/{args.resource_name}:deleteContact",
        account=args.account,
    )
    print(json.dumps({"deleted": args.resource_name}))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Google Contacts wrapper (People API v1)"
    )
    parser.add_argument(
        "--account",
        default="1",
        choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # list
    p_list = sub.add_parser("list", help="List contacts")
    p_list.add_argument(
        "--page-size", type=int, default=100, help="Number of contacts per page"
    )
    p_list.add_argument("--page-token", help="Token for next page of results")

    # get
    p_get = sub.add_parser("get", help="Get a single contact")
    p_get.add_argument(
        "--resource-name", required=True, help='Resource name (e.g. "people/c123456")'
    )

    # search
    p_search = sub.add_parser("search", help="Search contacts")
    p_search.add_argument("--query", required=True, help="Search query string")
    p_search.add_argument(
        "--page-size", type=int, default=30, help="Max results to return"
    )

    # create
    p_create = sub.add_parser("create", help="Create a new contact")
    p_create.add_argument("--given-name", help="First name")
    p_create.add_argument("--family-name", help="Last name")
    p_create.add_argument("--email", help="Email address")
    p_create.add_argument("--phone", help="Phone number")
    p_create.add_argument("--organization", help="Organization/company name")
    p_create.add_argument("--title", help="Job title")
    p_create.add_argument("--notes", help="Notes/biography")

    # update
    p_update = sub.add_parser("update", help="Update an existing contact")
    p_update.add_argument(
        "--resource-name", required=True, help='Resource name (e.g. "people/c123456")'
    )
    p_update.add_argument(
        "--etag", required=True, help="Contact etag (from get/list, required for concurrency)"
    )
    p_update.add_argument("--given-name", help="Updated first name")
    p_update.add_argument("--family-name", help="Updated last name")
    p_update.add_argument("--email", help="Updated email")
    p_update.add_argument("--phone", help="Updated phone")
    p_update.add_argument("--organization", help="Updated organization")
    p_update.add_argument("--title", help="Updated job title")
    p_update.add_argument("--notes", help="Updated notes")

    # delete
    p_delete = sub.add_parser("delete", help="Delete a contact")
    p_delete.add_argument(
        "--resource-name", required=True, help='Resource name (e.g. "people/c123456")'
    )

    args = parser.parse_args()

    try:
        {
            "list": cmd_list,
            "get": cmd_get,
            "search": cmd_search,
            "create": cmd_create,
            "update": cmd_update,
            "delete": cmd_delete,
        }[args.command](args)
    except Exception as e:
        log(f"Error: {e}")
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
