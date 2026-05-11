---
name: add-contacts
description: Add Google Contacts integration (list, search, create, update, delete contacts)
---

This skill adds Google Contacts (People API v1) support to NanoClaw via the IPC bridge pattern.

What it adds:

- Host-side IPC handler (src/contacts-ipc.ts) -- watches for contact requests from containers, executes google_contacts_wrapper.py, writes responses back
- Container-side MCP server (container/agent-runner/src/contacts-mcp-stdio.ts) -- exposes contacts tools to the agent via the MCP protocol
- Python wrapper (scripts/google_contacts_wrapper.py) -- CLI for People API v1 with multi-account support

Capabilities:

- list_contacts: List contacts with pagination
- get_contact: Get a single contact by resource name
- search_contacts: Search by name, email, or phone
- create_contact: Create a new contact
- update_contact: Update an existing contact (requires etag)
- delete_contact: Delete a contact by resource name

All tools support --account 1 (default) or --account 2 (secondary) for multi-account use.

Prerequisites:

- Merge skill/google-auth first -- the contacts scope is included in the Google OAuth setup
- Google OAuth credentials must be present at one of:
  - ~/.config/nanoclaw/secrets/google-gmail.json
  - ~/.openclaw/secrets/google-gmail.json
  - Or set via GMAIL_CREDS_FILE environment variable

Verification:

  python3 scripts/google_contacts_wrapper.py list

This should return a JSON object with your Google Contacts. If you get a 403 PERMISSION_DENIED error, re-authorize with python3 scripts/google_reauth.py to include the contacts scope.
