#!/usr/bin/env python3
"""Minimal Google Drive wrapper.

Capabilities:
- list files in Drive (with optional query filter, folder ID, max results)
- get file metadata by ID
- read file content by ID (text-based files only)
- search files by name/content query
- upload a file to Drive (to a specific folder)

No delete command on purpose.

Secrets are loaded from a credentials file or 1Password item.
Expected fields:
- client_id
- client_secret
- refresh_token

Defaults:
- credentials file: ~/.config/nanoclaw/secrets/google-drive.json
- user id: me

Examples:
  python3 scripts/google_drive_wrapper.py list --max-results 10
  python3 scripts/google_drive_wrapper.py list --folder-id FOLDER_ID
  python3 scripts/google_drive_wrapper.py list --query "mimeType='application/pdf'"
  python3 scripts/google_drive_wrapper.py get --id FILE_ID
  python3 scripts/google_drive_wrapper.py read --id FILE_ID
  python3 scripts/google_drive_wrapper.py search --query "budget report"
  python3 scripts/google_drive_wrapper.py upload --file /path/to/file.txt --folder-id FOLDER_ID
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

ITEM_TITLE = os.environ.get("GOOGLE_1PASSWORD_ITEM", "")

DRIVE_API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Module-level account override (set by --account flag before commands run)
_active_account: str = "1"


def _resolve_creds_file(account: str = "1") -> str:
    """Resolve credentials file path with flexible fallback.

    Search order per account:
      1. Env var GOOGLE_CREDS_FILE (account 1) / GOOGLE_CREDS_FILE_2 (account 2)
      2. ~/.config/nanoclaw/secrets/google-drive.json (or -2.json)
      3. ~/.openclaw/secrets/google-drive.json (or -2.json)
    """
    suffix = "" if account == "1" else f"-{account}"
    env_key = "GOOGLE_CREDS_FILE" if account == "1" else f"GOOGLE_CREDS_FILE_{account}"
    env_val = os.environ.get(env_key)
    if env_val:
        return os.path.expanduser(env_val)

    candidates = [
        os.path.expanduser(f"~/.config/nanoclaw/secrets/google-drive{suffix}.json"),
        os.path.expanduser(f"~/.openclaw/secrets/google-drive{suffix}.json"),
    ]
    for path_ in candidates:
        if os.path.exists(path_):
            return path_
    # Default to XDG path (will be created)
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
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {body_text}")
    return data["access_token"]


def api_request(
    method: str,
    url: str,
    params: dict | None = None,
    payload: dict | None = None,
    raw_data: bytes | None = None,
    extra_headers: dict | None = None,
) -> dict | str:
    token = get_access_token()
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = None
    if raw_data is not None:
        data = raw_data
    elif payload is not None:
        data = json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        raise RuntimeError(f"Drive API error {e.code}: {body_text}")


# --- Commands ---


def cmd_list(args: argparse.Namespace) -> int:
    params: dict[str, str] = {
        "pageSize": str(args.max_results),
        "fields": "files(id,name,mimeType,modifiedTime,size,parents),nextPageToken",
    }
    query_parts: list[str] = []
    if args.folder_id:
        query_parts.append(f"'{args.folder_id}' in parents")
    if args.query:
        query_parts.append(args.query)
    # Exclude trashed files by default
    query_parts.append("trashed = false")
    params["q"] = " and ".join(query_parts)

    result = api_request("GET", f"{DRIVE_API}/files", params=params)
    print(json.dumps(result, indent=2))
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    params = {"fields": "id,name,mimeType,modifiedTime,size,parents,webViewLink,description"}
    result = api_request("GET", f"{DRIVE_API}/files/{args.id}", params=params)
    print(json.dumps(result, indent=2))
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    # First get metadata to check mime type
    meta = api_request("GET", f"{DRIVE_API}/files/{args.id}", params={"fields": "mimeType,name"})
    if not isinstance(meta, dict):
        return die("Unexpected response from metadata request")

    mime = meta.get("mimeType", "")

    # Google Workspace files need export
    export_map = {
        "application/vnd.google-apps.document": "text/plain",
        "application/vnd.google-apps.spreadsheet": "text/csv",
        "application/vnd.google-apps.presentation": "text/plain",
        "application/vnd.google-apps.drawing": "image/svg+xml",
    }

    if mime in export_map:
        export_mime = export_map[mime]
        content = api_request(
            "GET",
            f"{DRIVE_API}/files/{args.id}/export",
            params={"mimeType": export_mime},
        )
    else:
        content = api_request(
            "GET",
            f"{DRIVE_API}/files/{args.id}",
            params={"alt": "media"},
        )

    if isinstance(content, dict):
        print(json.dumps(content, indent=2))
    else:
        print(content)
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    params: dict[str, str] = {
        "pageSize": str(args.max_results),
        "fields": "files(id,name,mimeType,modifiedTime,size,parents),nextPageToken",
        "q": f"fullText contains '{args.query}' and trashed = false",
    }
    result = api_request("GET", f"{DRIVE_API}/files", params=params)
    print(json.dumps(result, indent=2))
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    file_path = args.file
    if not os.path.exists(file_path):
        return die(f"File not found: {file_path}")

    file_name = os.path.basename(file_path)
    with open(file_path, "rb") as f:
        file_content = f.read()

    # Step 1: Create file metadata
    metadata: dict[str, object] = {"name": file_name}
    if args.folder_id:
        metadata["parents"] = [args.folder_id]

    # Simple upload for files under 5MB, multipart for larger
    # Using simple upload with metadata via multipart
    import mimetypes

    mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"

    # Build multipart body
    boundary = "nanoclaw_upload_boundary"
    body = b""
    body += f"--{boundary}\r\n".encode()
    body += b"Content-Type: application/json; charset=UTF-8\r\n\r\n"
    body += json.dumps(metadata).encode()
    body += b"\r\n"
    body += f"--{boundary}\r\n".encode()
    body += f"Content-Type: {mime_type}\r\n\r\n".encode()
    body += file_content
    body += b"\r\n"
    body += f"--{boundary}--".encode()

    result = api_request(
        "POST",
        f"{UPLOAD_API}/files",
        params={"uploadType": "multipart", "fields": "id,name,mimeType,size,webViewLink"},
        raw_data=body,
        extra_headers={"Content-Type": f"multipart/related; boundary={boundary}"},
    )
    print(json.dumps(result, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Minimal Google Drive wrapper")
    p.add_argument(
        "--account", default="1", choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # list
    p_list = sub.add_parser("list")
    p_list.add_argument("--query", default="", help="Drive query filter")
    p_list.add_argument("--folder-id", default=None, help="Parent folder ID")
    p_list.add_argument("--max-results", type=int, default=20, help="Max files to return")

    # get
    p_get = sub.add_parser("get")
    p_get.add_argument("--id", required=True, help="File ID")

    # read
    p_read = sub.add_parser("read")
    p_read.add_argument("--id", required=True, help="File ID")

    # search
    p_search = sub.add_parser("search")
    p_search.add_argument("--query", required=True, help="Search query")
    p_search.add_argument("--max-results", type=int, default=20, help="Max files to return")

    # upload
    p_upload = sub.add_parser("upload")
    p_upload.add_argument("--file", required=True, help="Local file path to upload")
    p_upload.add_argument("--folder-id", default=None, help="Target folder ID")

    return p


def main() -> int:
    global _active_account
    args = parser().parse_args()
    _active_account = getattr(args, "account", "1")
    try:
        if args.command == "list":
            return cmd_list(args)
        if args.command == "get":
            return cmd_get(args)
        if args.command == "read":
            return cmd_read(args)
        if args.command == "search":
            return cmd_search(args)
        if args.command == "upload":
            return cmd_upload(args)
        return die("Unknown command")
    except Exception as e:
        return die(str(e))


if __name__ == "__main__":
    raise SystemExit(main())
