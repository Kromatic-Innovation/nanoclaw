#!/usr/bin/env python3
"""One-time Spotify OAuth2 authorization flow.

Reads client_id and client_secret from macOS Keychain, opens browser for
user authorization, catches the callback on localhost:8888, exchanges the
code for tokens, and stores the refresh_token in Keychain.

Usage:
  python3 scripts/spotify_auth.py
"""

from __future__ import annotations

import http.server
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import urllib.error
import webbrowser

REDIRECT_URI = "http://127.0.0.1:8888/callback"
SCOPES = "user-follow-read user-follow-modify"
TOKEN_URL = "https://accounts.spotify.com/api/token"
AUTH_URL = "https://accounts.spotify.com/authorize"


def keychain_get(service: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", service, "-w"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Keychain item '{service}' not found")
    return result.stdout.strip()


def keychain_set(service: str, value: str) -> None:
    # Delete existing entry if present (ignore errors)
    subprocess.run(
        ["security", "delete-generic-password", "-a", os.environ.get("USER", ""), "-s", service],
        capture_output=True, timeout=5,
    )
    subprocess.run(
        ["security", "add-generic-password", "-a", os.environ.get("USER", ""), "-s", service, "-w", value],
        check=True, capture_output=True, timeout=5,
    )


def main() -> int:
    print("Reading credentials from Keychain...")
    try:
        client_id = keychain_get("spotify-client-id")
        client_secret = keychain_get("spotify-client-secret")
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    auth_code: str | None = None
    error: str | None = None
    server_ready = threading.Event()

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal auth_code, error
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            if "code" in params:
                auth_code = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Authorization successful!</h1><p>You can close this tab.</p>")
            elif "error" in params:
                error = params["error"][0]
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(f"<h1>Error: {error}</h1>".encode())
            else:
                self.send_response(404)
                self.end_headers()

            # Shut down server after handling
            threading.Thread(target=self.server.shutdown).start()

        def log_message(self, format, *args):
            pass  # Suppress request logs

    server = http.server.HTTPServer(("127.0.0.1", 8888), CallbackHandler)

    # Build auth URL
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
    })
    url = f"{AUTH_URL}?{params}"

    print(f"\nOpening browser for authorization...")
    print(f"If it doesn't open, visit:\n{url}\n")
    webbrowser.open(url)

    print("Waiting for callback on http://127.0.0.1:8888 ...\n")
    server.serve_forever()

    if error:
        print(f"Authorization failed: {error}", file=sys.stderr)
        return 1

    if not auth_code:
        print("No authorization code received", file=sys.stderr)
        return 1

    # Exchange code for tokens
    print("Exchanging code for tokens...")
    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "code": auth_code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "client_secret": client_secret,
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
        print(f"Token exchange failed ({e.code}): {err_body}", file=sys.stderr)
        return 1

    refresh_token = data.get("refresh_token")
    if not refresh_token:
        print("No refresh_token in response!", file=sys.stderr)
        print(json.dumps(data, indent=2), file=sys.stderr)
        return 1

    # Store refresh token in Keychain
    print("Storing refresh_token in Keychain...")
    keychain_set("spotify-refresh-token", refresh_token)

    print("\nDone! Spotify OAuth is configured.")
    print(f"  Scopes: {SCOPES}")
    print(f"  Refresh token stored as: spotify-refresh-token")
    return 0


if __name__ == "__main__":
    sys.exit(main())
