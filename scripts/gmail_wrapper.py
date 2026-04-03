#!/usr/bin/env python3
"""Minimal Gmail wrapper.

Capabilities:
- list messages
- get message
- list labels
- add/remove labels
- create a label
- create a new draft
- create a reply draft
- send a new email or reply-all (for explicitly authorized workflows)

Secrets are loaded from a 1Password item via `op item get ... --format json`.
Expected custom fields in the item:
- client_id
- client_secret
- refresh_token

Defaults:
- item title: "Google API Key for OpenClaw (KroClaw)"
- user id: me

Examples:
  python3 scripts/gmail_wrapper.py labels
  python3 scripts/gmail_wrapper.py list --query 'in:inbox newer_than:7d' --limit 10
  python3 scripts/gmail_wrapper.py get --id <message_id>
  python3 scripts/gmail_wrapper.py thread --id <message_id>
  python3 scripts/gmail_wrapper.py label-create --name claw-spam
  python3 scripts/gmail_wrapper.py label-add --id <message_id> --labels follow-up
  python3 scripts/gmail_wrapper.py label-remove --id <message_id> --labels INBOX
  python3 scripts/gmail_wrapper.py draft-new --to someone@example.com --subject 'Hello' --body 'Hi there'
  python3 scripts/gmail_wrapper.py draft-reply --id <message_id> --body 'Thanks — sounds good.'
  python3 scripts/gmail_wrapper.py draft-reply-all --id <message_id> --body 'Thanks everyone.'
  python3 scripts/gmail_wrapper.py send-reply-all --id <message_id> --body 'Thanks everyone.'
"""

from __future__ import annotations

import argparse
import base64
import email.utils
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

ITEM_TITLE = os.environ.get("GMAIL_1PASSWORD_ITEM", "")


def _resolve_creds_file(account: str) -> str:
    """Find the credentials file for the given account number."""
    env_key = "GOOGLE_CREDS_FILE" if account == "1" else "GOOGLE_CREDS_FILE_2"
    if os.environ.get(env_key):
        return os.environ[env_key]

    suffix = "google-gmail.json" if account == "1" else "google-gmail-2.json"
    candidates = [
        os.path.expanduser(f"~/.config/nanoclaw/secrets/{suffix}"),
        os.path.expanduser(f"~/.openclaw/secrets/{suffix}"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    # Default to XDG path (will be created)
    return candidates[0]


CREDS_FILES = {
    "1": _resolve_creds_file("1"),
    "2": _resolve_creds_file("2"),
}
CREDS_FILE = CREDS_FILES["1"]  # default for backwards compat
USER_ID = os.environ.get("GMAIL_USER_ID", "me")
SELF_EMAILS = {s.strip().lower() for s in os.environ.get("GMAIL_SELF_EMAILS", "").split(",") if s.strip()}
GMAIL_API = f"https://gmail.googleapis.com/gmail/v1/users/{USER_ID}"
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
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Token refresh failed ({e.code}): {body}")
    return data["access_token"]


def api_request(method: str, path: str, params: dict | None = None, payload: dict | None = None) -> dict:
    token = get_access_token()
    url = GMAIL_API + path
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
        raise RuntimeError(f"Gmail API error {e.code}: {body}")


def header_map(message: dict) -> dict[str, str]:
    headers = {}
    for h in message.get("payload", {}).get("headers", []):
        name = h.get("name")
        value = h.get("value")
        if name and value:
            headers[name.lower()] = value
    return headers


def parse_addresses(value: str | None) -> list[str]:
    if not value:
        return []
    return [addr for _name, addr in email.utils.getaddresses([value]) if addr]


def dedupe_preserve(items: list[str]) -> list[str]:
    seen = set()
    out = []
    for item in items:
        key = item.lower()
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def message_summary(detail: dict) -> dict:
    headers = header_map(detail)
    return {
        "id": detail.get("id"),
        "threadId": detail.get("threadId"),
        "from": headers.get("from"),
        "to": headers.get("to"),
        "cc": headers.get("cc"),
        "subject": headers.get("subject"),
        "date": headers.get("date"),
        "snippet": detail.get("snippet"),
        "labelIds": detail.get("labelIds", []),
    }


def find_label_ids(label_names: list[str]) -> list[str]:
    labels = api_request("GET", "/labels").get("labels", [])
    lookup = {}
    for label in labels:
        lookup[label["id"].lower()] = label["id"]
        lookup[label["name"].lower()] = label["id"]
    result = []
    missing = []
    for name in label_names:
        label_id = lookup.get(name.lower())
        if label_id:
            result.append(label_id)
        else:
            missing.append(name)
    if missing:
        raise RuntimeError(f"Unknown label(s): {', '.join(missing)}")
    return result


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def ensure_re_subject(subject: str) -> str:
    if subject.lower().startswith("re:"):
        return subject
    return f"Re: {subject}"


def draft_new(to: str, subject: str, body: str) -> dict:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    return api_request("POST", "/drafts", payload={"message": {"raw": b64url(msg.as_bytes())}})


def send_new(to: str, subject: str, body: str) -> dict:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    return api_request("POST", "/messages/send", payload={"raw": b64url(msg.as_bytes())})


def draft_reply(message_id: str, body: str) -> dict:
    original = api_request("GET", f"/messages/{message_id}", params={"format": "full"})
    headers = header_map(original)
    to_addr = headers.get("reply-to") or headers.get("from")
    subject = ensure_re_subject(headers.get("subject", "(no subject)"))

    msg = EmailMessage()
    msg["To"] = to_addr
    msg["Subject"] = subject
    if headers.get("message-id"):
        msg["In-Reply-To"] = headers["message-id"]
        msg["References"] = headers["message-id"]
    msg.set_content(body)

    payload = {
        "message": {
            "threadId": original.get("threadId"),
            "raw": b64url(msg.as_bytes()),
        }
    }
    return api_request("POST", "/drafts", payload=payload)


def build_reply_all_message(message_id: str, body: str, allow_self: bool = False, cc: str | None = None, bcc: str | None = None) -> tuple[dict, dict]:
    original = api_request("GET", f"/messages/{message_id}", params={"format": "full"})
    headers = header_map(original)
    subject = ensure_re_subject(headers.get("subject", "(no subject)"))

    to_list = parse_addresses(headers.get("reply-to") or headers.get("from"))
    cc_list = parse_addresses(headers.get("to")) + parse_addresses(headers.get("cc"))

    if not allow_self:
        to_list = [a for a in to_list if a.lower() not in SELF_EMAILS]
        cc_list = [a for a in cc_list if a.lower() not in SELF_EMAILS and a.lower() not in {x.lower() for x in to_list}]

    # Add extra CC recipients from --cc parameter
    if cc:
        extra_cc = [addr.strip() for addr in cc.split(",") if addr.strip()]
        cc_list.extend(extra_cc)

    # BCC recipients
    bcc_list: list[str] = []
    if bcc:
        bcc_list = [addr.strip() for addr in bcc.split(",") if addr.strip()]

    msg = EmailMessage()
    if to_list:
        msg["To"] = ", ".join(dedupe_preserve(to_list))
    if cc_list:
        msg["Cc"] = ", ".join(dedupe_preserve(cc_list))
    if bcc_list:
        msg["Bcc"] = ", ".join(dedupe_preserve(bcc_list))
    msg["Subject"] = subject
    if headers.get("message-id"):
        msg["In-Reply-To"] = headers["message-id"]
        msg["References"] = headers["message-id"]
    msg.set_content(body)

    return original, msg


def draft_reply_all(message_id: str, body: str, allow_self: bool = False, cc: str | None = None, bcc: str | None = None) -> dict:
    original, msg = build_reply_all_message(message_id, body, allow_self=allow_self, cc=cc, bcc=bcc)
    payload = {
        "message": {
            "threadId": original.get("threadId"),
            "raw": b64url(msg.as_bytes()),
        }
    }
    return api_request("POST", "/drafts", payload=payload)


def send_reply_all(message_id: str, body: str, allow_self: bool = False, cc: str | None = None, bcc: str | None = None) -> dict:
    original, msg = build_reply_all_message(message_id, body, allow_self=allow_self, cc=cc, bcc=bcc)
    payload = {
        "threadId": original.get("threadId"),
        "raw": b64url(msg.as_bytes()),
    }
    return api_request("POST", "/messages/send", payload=payload)


def cmd_labels(_args: argparse.Namespace) -> int:
    data = api_request("GET", "/labels")
    print(json.dumps(data.get("labels", []), indent=2))
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    params = {"maxResults": args.limit}
    if args.query:
        params["q"] = args.query
    data = api_request("GET", "/messages", params=params)
    msgs = []
    for msg in data.get("messages", [])[: args.limit]:
        detail = api_request("GET", f"/messages/{msg['id']}", params={"format": "metadata"})
        headers = header_map(detail)
        msgs.append(
            {
                "id": detail.get("id"),
                "threadId": detail.get("threadId"),
                "from": headers.get("from"),
                "subject": headers.get("subject"),
                "date": headers.get("date"),
                "snippet": detail.get("snippet"),
            }
        )
    print(json.dumps(msgs, indent=2))
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    data = api_request("GET", f"/messages/{args.id}", params={"format": args.format})
    print(json.dumps(data, indent=2))
    return 0


def cmd_thread(args: argparse.Namespace) -> int:
    msg = api_request("GET", f"/messages/{args.id}", params={"format": "metadata"})
    thread = api_request("GET", f"/threads/{msg['threadId']}", params={"format": "metadata"})
    out = [message_summary(m) for m in thread.get("messages", [])]
    print(json.dumps(out, indent=2))
    return 0


def cmd_label_create(args: argparse.Namespace) -> int:
    payload = {
        "name": args.name,
        "labelListVisibility": "labelShow",
        "messageListVisibility": "show",
    }
    data = api_request("POST", "/labels", payload=payload)
    print(json.dumps(data, indent=2))
    return 0


def cmd_modify(args: argparse.Namespace, add: bool) -> int:
    label_ids = find_label_ids(args.labels)
    payload = {"addLabelIds": label_ids if add else [], "removeLabelIds": [] if add else label_ids}
    data = api_request("POST", f"/messages/{args.id}/modify", payload=payload)
    print(json.dumps({"id": data.get("id"), "labelIds": data.get("labelIds", [])}, indent=2))
    return 0


def cmd_draft_new(args: argparse.Namespace) -> int:
    data = draft_new(args.to, args.subject, args.body)
    print(json.dumps(data, indent=2))
    return 0


def cmd_send_new(args: argparse.Namespace) -> int:
    data = send_new(args.to, args.subject, args.body)
    print(json.dumps(data, indent=2))
    return 0


def cmd_draft_reply(args: argparse.Namespace) -> int:
    data = draft_reply(args.id, args.body)
    print(json.dumps(data, indent=2))
    return 0


def cmd_draft_reply_all(args: argparse.Namespace) -> int:
    data = draft_reply_all(args.id, args.body, allow_self=args.allow_self, cc=args.cc, bcc=args.bcc)
    print(json.dumps(data, indent=2))
    return 0


def cmd_send_reply_all(args: argparse.Namespace) -> int:
    data = send_reply_all(args.id, args.body, allow_self=args.allow_self, cc=args.cc, bcc=args.bcc)
    print(json.dumps(data, indent=2))
    return 0


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Minimal Gmail wrapper")
    p.add_argument(
        "--account", default="1", choices=["1", "2"],
        help="Google account to use (1 = default, 2 = secondary)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("labels")

    p_thread = sub.add_parser("thread")
    p_thread.add_argument("--id", required=True)

    p_label_create = sub.add_parser("label-create")
    p_label_create.add_argument("--name", required=True)

    p_list = sub.add_parser("list")
    p_list.add_argument("--query", default="")
    p_list.add_argument("--limit", type=int, default=10)

    p_get = sub.add_parser("get")
    p_get.add_argument("--id", required=True)
    p_get.add_argument("--format", default="full", choices=["full", "metadata", "minimal", "raw"])

    for name in ["label-add", "label-remove"]:
        p_mod = sub.add_parser(name)
        p_mod.add_argument("--id", required=True)
        p_mod.add_argument("--labels", nargs="+", required=True)

    p_dn = sub.add_parser("draft-new")
    p_dn.add_argument("--to", required=True)
    p_dn.add_argument("--subject", required=True)
    p_dn.add_argument("--body", required=True)

    p_sn = sub.add_parser("send-new")
    p_sn.add_argument("--to", required=True)
    p_sn.add_argument("--subject", required=True)
    p_sn.add_argument("--body", required=True)

    p_dr = sub.add_parser("draft-reply")
    p_dr.add_argument("--id", required=True)
    p_dr.add_argument("--body", required=True)

    p_dra = sub.add_parser("draft-reply-all")
    p_dra.add_argument("--id", required=True)
    p_dra.add_argument("--body", required=True)
    p_dra.add_argument("--allow-self", action="store_true")
    p_dra.add_argument("--cc", default=None, help="Comma-separated CC recipients")
    p_dra.add_argument("--bcc", default=None, help="Comma-separated BCC recipients")

    p_sra = sub.add_parser("send-reply-all")
    p_sra.add_argument("--id", required=True)
    p_sra.add_argument("--body", required=True)
    p_sra.add_argument("--allow-self", action="store_true")
    p_sra.add_argument("--cc", default=None, help="Comma-separated CC recipients")
    p_sra.add_argument("--bcc", default=None, help="Comma-separated BCC recipients")

    return p


def main() -> int:
    global _active_account
    args = parser().parse_args()
    _active_account = getattr(args, "account", "1")
    try:
        if args.command == "labels":
            return cmd_labels(args)
        if args.command == "thread":
            return cmd_thread(args)
        if args.command == "label-create":
            return cmd_label_create(args)
        if args.command == "list":
            return cmd_list(args)
        if args.command == "get":
            return cmd_get(args)
        if args.command == "label-add":
            return cmd_modify(args, add=True)
        if args.command == "label-remove":
            return cmd_modify(args, add=False)
        if args.command == "draft-new":
            return cmd_draft_new(args)
        if args.command == "send-new":
            return cmd_send_new(args)
        if args.command == "draft-reply":
            return cmd_draft_reply(args)
        if args.command == "draft-reply-all":
            return cmd_draft_reply_all(args)
        if args.command == "send-reply-all":
            return cmd_send_reply_all(args)
        return die("Unknown command")
    except Exception as e:
        return die(str(e))


if __name__ == "__main__":
    raise SystemExit(main())
