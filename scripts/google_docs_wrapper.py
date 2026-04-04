#!/usr/bin/env python3
"""Minimal Google Docs wrapper.

Capabilities:
- get: Get document metadata and full text content by document ID
- create: Create a new Google Doc with title and optional initial body text
- append: Append text to the end of an existing document
- search: Search for documents by name/content (uses Drive API)
- list: List recent documents (uses Drive API with mimeType filter)

Auth: Same OAuth pattern as other Google wrappers (creds file or 1Password).
Scopes:
- https://www.googleapis.com/auth/documents (Docs API)
- https://www.googleapis.com/auth/drive.readonly (search/list via Drive API)

Examples:
  python3 scripts/google_docs_wrapper.py get --doc-id DOC_ID
  python3 scripts/google_docs_wrapper.py create --title 'Meeting Notes'
  python3 scripts/google_docs_wrapper.py create --title 'Draft' --body 'Initial content here.'
  python3 scripts/google_docs_wrapper.py append --doc-id DOC_ID --text 'Appended paragraph.'
  python3 scripts/google_docs_wrapper.py search --query 'meeting notes'
  python3 scripts/google_docs_wrapper.py list --limit 10
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

OP_VAULT = os.environ.get("GOOGLE_1PASSWORD_VAULT", "Agent Tools")
OP_CLIENT_ITEM = os.environ.get("GOOGLE_1PASSWORD_CLIENT", "Google OAuth Client")
OP_CREDS_ITEMS = {
    "1": os.environ.get("GOOGLE_1PASSWORD_ITEM", "Google OAuth Credentials"),
    "2": os.environ.get("GOOGLE_1PASSWORD_ITEM_2", "Google OAuth Credentials 2"),
}

DOCS_API = "https://docs.googleapis.com/v1"
DRIVE_API = "https://www.googleapis.com/drive/v3"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Module-level account override (set by --account flag before commands run)
_active_account: str = "1"


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

    return candidates[0]


CREDS_FILES = {
    "1": _resolve_creds_file("1"),
    "2": _resolve_creds_file("2"),
}


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


def _op_read(uri: str) -> str | None:
    """Read a single field via op:// URI. Returns None on failure."""
    try:
        val = op_run(["op", "read", uri]).strip()
        return val or None
    except RuntimeError:
        return None


def _load_creds_from_op() -> tuple[str, str, str] | None:
    """Try loading credentials from 1Password (primary source)."""
    creds_item = OP_CREDS_ITEMS.get(_active_account, OP_CREDS_ITEMS["1"])
    client_base = f"op://{OP_VAULT}/{OP_CLIENT_ITEM}"
    creds_base = f"op://{OP_VAULT}/{creds_item}"

    client_id = _op_read(f"{client_base}/client-id") or _op_read(f"{client_base}/client_id")
    client_secret = _op_read(f"{client_base}/client-secret") or _op_read(f"{client_base}/client_secret")

    if not client_id or not client_secret:
        client_id = _op_read(f"{creds_base}/client-id") or _op_read(f"{creds_base}/client_id")
        client_secret = _op_read(f"{creds_base}/client-secret") or _op_read(f"{creds_base}/client_secret")

    refresh_token = _op_read(f"{creds_base}/refresh-token") or _op_read(f"{creds_base}/refresh_token")

    if client_id and client_secret and refresh_token:
        return client_id, client_secret, refresh_token
    return None


def _load_creds_from_file() -> tuple[str, str, str] | None:
    """Try loading credentials from local file (fallback)."""
    creds_file = CREDS_FILES.get(_active_account, CREDS_FILES["1"])
    if not os.path.exists(creds_file):
        return None
    with open(creds_file) as f:
        data = json.load(f)
    client_id = (data.get("client_id") or "").strip()
    client_secret = (data.get("client_secret") or "").strip()
    refresh_token = (data.get("refresh_token") or "").strip()
    if client_id and client_secret and refresh_token:
        return client_id, client_secret, refresh_token
    return None


def load_creds() -> tuple[str, str, str]:
    """Load OAuth credentials. 1Password first, local file fallback."""
    result = _load_creds_from_op()
    if result:
        return result
    result = _load_creds_from_file()
    if result:
        return result
    raise RuntimeError(
        f"Google OAuth credentials not found in 1Password. "
        f"Expected '{OP_CLIENT_ITEM}' (client-id, client-secret) and "
        f"'{OP_CREDS_ITEMS.get(_active_account)}' (refresh-token) in vault '{OP_VAULT}'. "
        f"Run google_reauth.py to set up."
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
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {body_text}")
    return data["access_token"]


def api_request(
    method: str,
    url: str,
    params: dict | None = None,
    payload: dict | None = None,
) -> dict:
    """Make an authenticated API request. URL must be a full URL."""
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
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"API error {e.code}: {body_text}")


# --- Helpers ---

def extract_text(doc: dict) -> str:
    """Extract plain text from a Google Docs document body."""
    body = doc.get("body", {})
    content = body.get("content", [])
    parts: list[str] = []
    for element in content:
        paragraph = element.get("paragraph")
        if paragraph:
            for pe in paragraph.get("elements", []):
                text_run = pe.get("textRun")
                if text_run:
                    parts.append(text_run.get("content", ""))
    return "".join(parts)


def get_end_index(doc: dict) -> int:
    """Get the end index of the document body (for appending)."""
    body = doc.get("body", {})
    content = body.get("content", [])
    if content:
        last = content[-1]
        return last.get("endIndex", 1) - 1
    return 1


# --- Commands ---

def cmd_get(args: argparse.Namespace) -> int:
    url = f"{DOCS_API}/documents/{urllib.parse.quote(args.doc_id, safe='')}"
    doc = api_request("GET", url)
    text = extract_text(doc)
    result = {
        "documentId": doc.get("documentId"),
        "title": doc.get("title"),
        "revisionId": doc.get("revisionId"),
        "text": text,
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    if not args.title:
        return die("create requires --title")

    # Step 1: Create the document
    url = f"{DOCS_API}/documents"
    doc = api_request("POST", url, payload={"title": args.title})
    doc_id = doc.get("documentId", "")

    # Step 2: If body text provided, insert it
    if args.body:
        batch_url = f"{DOCS_API}/documents/{urllib.parse.quote(doc_id, safe='')}:batchUpdate"
        requests = [
            {
                "insertText": {
                    "location": {"index": 1},
                    "text": args.body,
                }
            }
        ]
        api_request("POST", batch_url, payload={"requests": requests})

    result = {
        "documentId": doc_id,
        "title": doc.get("title"),
        "url": f"https://docs.google.com/document/d/{doc_id}/edit",
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_append(args: argparse.Namespace) -> int:
    if not args.doc_id:
        return die("append requires --doc-id")
    if not args.text:
        return die("append requires --text")

    # Get the document to find the end index
    doc_url = f"{DOCS_API}/documents/{urllib.parse.quote(args.doc_id, safe='')}"
    doc = api_request("GET", doc_url)
    end_index = get_end_index(doc)

    # Ensure text starts with a newline for clean separation
    text = args.text
    if end_index > 1 and not text.startswith("\n"):
        text = "\n" + text

    batch_url = f"{DOCS_API}/documents/{urllib.parse.quote(args.doc_id, safe='')}:batchUpdate"
    requests = [
        {
            "insertText": {
                "location": {"index": end_index},
                "text": text,
            }
        }
    ]
    api_request("POST", batch_url, payload={"requests": requests})

    result = {
        "documentId": args.doc_id,
        "appended": len(text),
        "status": "ok",
    }
    print(json.dumps(result, indent=2))
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    if not args.query:
        return die("search requires --query")

    # Use Drive API to search for Google Docs by name/content
    q_parts = [
        "mimeType='application/vnd.google-apps.document'",
        f"fullText contains '{args.query}'",
        "trashed=false",
    ]
    params = {
        "q": " and ".join(q_parts),
        "fields": "files(id,name,modifiedTime,owners,webViewLink)",
        "orderBy": "modifiedTime desc",
        "pageSize": str(args.limit),
    }
    url = f"{DRIVE_API}/files"
    data = api_request("GET", url, params=params)
    files = data.get("files", [])
    results = []
    for f in files:
        results.append({
            "documentId": f.get("id"),
            "title": f.get("name"),
            "modifiedTime": f.get("modifiedTime"),
            "url": f.get("webViewLink"),
        })
    print(json.dumps(results, indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    params = {
        "q": "mimeType='application/vnd.google-apps.document' and trashed=false",
        "fields": "files(id,name,modifiedTime,owners,webViewLink)",
        "orderBy": "modifiedTime desc",
        "pageSize": str(args.limit),
    }
    url = f"{DRIVE_API}/files"
    data = api_request("GET", url, params=params)
    files = data.get("files", [])
    results = []
    for f in files:
        results.append({
            "documentId": f.get("id"),
            "title": f.get("name"),
            "modifiedTime": f.get("modifiedTime"),
            "url": f.get("webViewLink"),
        })
    print(json.dumps(results, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Minimal Google Docs wrapper")
    p.add_argument(
        "--account", default="1", choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    p_get = sub.add_parser("get")
    p_get.add_argument("--doc-id", required=True, help="Document ID")

    p_create = sub.add_parser("create")
    p_create.add_argument("--title", required=True, help="Document title")
    p_create.add_argument("--body", help="Initial body text")

    p_append = sub.add_parser("append")
    p_append.add_argument("--doc-id", required=True, help="Document ID")
    p_append.add_argument("--text", required=True, help="Text to append")

    p_search = sub.add_parser("search")
    p_search.add_argument("--query", required=True, help="Search query")
    p_search.add_argument("--limit", type=int, default=10, help="Max results")

    p_list = sub.add_parser("list")
    p_list.add_argument("--limit", type=int, default=10, help="Max results")

    return p


def main() -> int:
    global _active_account
    args = parser().parse_args()
    _active_account = getattr(args, "account", "1")
    try:
        if args.command == "get":
            return cmd_get(args)
        if args.command == "create":
            return cmd_create(args)
        if args.command == "append":
            return cmd_append(args)
        if args.command == "search":
            return cmd_search(args)
        if args.command == "list":
            return cmd_list(args)
        return die("Unknown command")
    except Exception as e:
        return die(str(e))


if __name__ == "__main__":
    raise SystemExit(main())
