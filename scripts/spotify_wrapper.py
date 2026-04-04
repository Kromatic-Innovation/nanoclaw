#!/usr/bin/env python3
"""Minimal Spotify API wrapper.

Capabilities:
- search: search for artists, tracks, albums
- following: check if user follows artists
- follow: follow an artist
- unfollow: unfollow an artist
- artist: get artist details

Auth: client_id, client_secret, refresh_token from macOS Keychain.

Examples:
  python3 scripts/spotify_wrapper.py search --query "Radiohead" --type artist
  python3 scripts/spotify_wrapper.py artist --id 4Z8W4fKeB5YxbusRsdQVPb
  python3 scripts/spotify_wrapper.py following --ids 4Z8W4fKeB5YxbusRsdQVPb,1dfeR4HaWDbWqFHLkxsg1d
  python3 scripts/spotify_wrapper.py follow --id 4Z8W4fKeB5YxbusRsdQVPb
  python3 scripts/spotify_wrapper.py unfollow --id 4Z8W4fKeB5YxbusRsdQVPb
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

TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"


def die(message: str, code: int = 1) -> int:
    print(json.dumps({"error": message}), file=sys.stdout)
    return code


def keychain_get(service: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", service, "-w"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Keychain item '{service}' not found")
    return result.stdout.strip()


def credential_get(env_var: str, keychain_service: str) -> str:
    """Return env var if set, otherwise fall back to macOS Keychain."""
    value = os.environ.get(env_var)
    if value:
        return value
    return keychain_get(keychain_service)


def get_access_token() -> str:
    client_id = credential_get("SPOTIFY_CLIENT_ID", "spotify-client-id")
    client_secret = credential_get("SPOTIFY_CLIENT_SECRET", "spotify-client-secret")
    refresh_token = credential_get("SPOTIFY_REFRESH_TOKEN", "spotify-refresh-token")

    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
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
        raise RuntimeError(f"Token refresh failed ({e.code}): {err_body}")
    return data["access_token"]


def api_request(method: str, path: str, params: dict | None = None, data: dict | None = None) -> dict | list | None:
    token = get_access_token()
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"Spotify API error {e.code}: {err_body}")


def cmd_search(args: argparse.Namespace) -> int:
    """Search for artists, tracks, or albums."""
    try:
        result = api_request("GET", "/search", params={
            "q": args.query,
            "type": args.type,
            "limit": str(args.limit),
        })
        # Simplify output for artist searches
        if args.type == "artist" and result and "artists" in result:
            artists = [
                {
                    "id": a["id"],
                    "name": a["name"],
                    "genres": a.get("genres", []),
                    "followers": a.get("followers", {}).get("total", 0),
                    "popularity": a.get("popularity", 0),
                    "url": a.get("external_urls", {}).get("spotify"),
                }
                for a in result["artists"].get("items", [])
            ]
            print(json.dumps(artists, indent=2))
        else:
            print(json.dumps(result, indent=2))
        return 0
    except RuntimeError as err:
        return die(str(err))


def cmd_artist(args: argparse.Namespace) -> int:
    """Get artist details."""
    try:
        result = api_request("GET", f"/artists/{args.id}")
        if result:
            summary = {
                "id": result["id"],
                "name": result["name"],
                "genres": result.get("genres", []),
                "followers": result.get("followers", {}).get("total", 0),
                "popularity": result.get("popularity", 0),
                "url": result.get("external_urls", {}).get("spotify"),
            }
            print(json.dumps(summary, indent=2))
        return 0
    except RuntimeError as err:
        return die(str(err))


def cmd_following(args: argparse.Namespace) -> int:
    """Check if the user follows one or more artists."""
    try:
        ids = [i.strip() for i in args.ids.split(",")]
        result = api_request("GET", "/me/following/contains", params={
            "type": "artist",
            "ids": ",".join(ids),
        })
        # Return a mapping of id → followed
        if isinstance(result, list):
            output = {aid: follows for aid, follows in zip(ids, result)}
            print(json.dumps(output, indent=2))
        else:
            print(json.dumps(result, indent=2))
        return 0
    except RuntimeError as err:
        return die(str(err))


def cmd_follow(args: argparse.Namespace) -> int:
    """Follow an artist."""
    try:
        api_request("PUT", "/me/following", params={"type": "artist", "ids": args.id})
        print(json.dumps({"followed": args.id}))
        return 0
    except RuntimeError as err:
        return die(str(err))


def cmd_unfollow(args: argparse.Namespace) -> int:
    """Unfollow an artist."""
    try:
        api_request("DELETE", "/me/following", params={"type": "artist", "ids": args.id})
        print(json.dumps({"unfollowed": args.id}))
        return 0
    except RuntimeError as err:
        return die(str(err))


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal Spotify API wrapper")
    sub = parser.add_subparsers(dest="command")

    p_search = sub.add_parser("search")
    p_search.add_argument("--query", required=True)
    p_search.add_argument("--type", default="artist", choices=["artist", "track", "album"])
    p_search.add_argument("--limit", type=int, default=5)

    p_artist = sub.add_parser("artist")
    p_artist.add_argument("--id", required=True)

    p_following = sub.add_parser("following")
    p_following.add_argument("--ids", required=True, help="Comma-separated artist IDs")

    p_follow = sub.add_parser("follow")
    p_follow.add_argument("--id", required=True)

    p_unfollow = sub.add_parser("unfollow")
    p_unfollow.add_argument("--id", required=True)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return 1

    dispatch = {
        "search": cmd_search,
        "artist": cmd_artist,
        "following": cmd_following,
        "follow": cmd_follow,
        "unfollow": cmd_unfollow,
    }
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
