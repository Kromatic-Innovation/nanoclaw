"""
Load private configuration from config/private.yaml.

Falls back to environment variables if the config file doesn't exist,
so the scripts work in CI or containerized environments without the file.
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def load_private_config(config_dir: Path | None = None) -> dict:
    """Load config/private.yaml, merging with env var overrides."""
    if config_dir is None:
        config_dir = Path(__file__).resolve().parent.parent / "config"

    config_path = config_dir / "private.yaml"
    config: dict = {}

    if config_path.exists():
        try:
            # Use PyYAML if available, otherwise parse the simple YAML manually
            import yaml
            with open(config_path) as f:
                config = yaml.safe_load(f) or {}
        except ImportError:
            config = _parse_simple_yaml(config_path)

    # Build merged config with env var overrides
    return {
        "github": {
            "owner": os.environ.get(
                "GITHUB_OWNER",
                _nested_get(config, "github", "owner", default=""),
            ),
        },
        "sentry": {
            "org": os.environ.get(
                "SENTRY_ORG",
                _nested_get(config, "sentry", "org", default=""),
            ),
            "baseUrl": os.environ.get(
                "SENTRY_BASE_URL",
                _nested_get(config, "sentry", "baseUrl", default="https://us.sentry.io"),
            ),
            "repoMap": _load_repo_map(config),
        },
        "budget": {
            "maxDailySpend": float(os.environ.get(
                "MAX_DAILY_SPEND",
                _nested_get(config, "budget", "maxDailySpend", default=3.0),
            )),
            "maxWeeklySpend": float(os.environ.get(
                "MAX_WEEKLY_SPEND",
                _nested_get(config, "budget", "maxWeeklySpend", default=15.0),
            )),
        },
        "repoMaintenance": {
            "dailyRepos": _load_daily_repos(config),
            "weeklyDay": int(os.environ.get(
                "WEEKLY_DAY",
                _nested_get(config, "repoMaintenance", "weeklyDay", default=3),
            )),
            "scheduledRepos": _load_scheduled_repos(config),
        },
    }


def _nested_get(d: dict, *keys: str, default=None):
    """Safely traverse nested dict keys."""
    for key in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(key, default)
    return d


def _load_repo_map(config: dict) -> dict[str, list[str]]:
    """Load Sentry repo map from config or SENTRY_REPO_MAP env var (JSON)."""
    env_map = os.environ.get("SENTRY_REPO_MAP")
    if env_map:
        try:
            return json.loads(env_map)
        except json.JSONDecodeError:
            pass
    return _nested_get(config, "sentry", "repoMap", default={}) or {}


def _load_daily_repos(config: dict) -> set[str]:
    """Load daily repos from config or DAILY_REPOS env var (comma-separated)."""
    env_repos = os.environ.get("DAILY_REPOS")
    if env_repos:
        return set(r.strip() for r in env_repos.split(",") if r.strip())
    repos = _nested_get(config, "repoMaintenance", "dailyRepos", default=[]) or []
    return set(repos)


DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _load_scheduled_repos(config: dict) -> dict[str, list[str]]:
    """Load per-day scheduled repos from config.

    Returns a dict mapping day name (lowercase) to list of repo slugs.
    Also accepts SCHEDULED_REPOS env var as JSON override.
    """
    env_val = os.environ.get("SCHEDULED_REPOS")
    if env_val:
        try:
            return json.loads(env_val)
        except json.JSONDecodeError:
            pass
    raw = _nested_get(config, "repoMaintenance", "scheduledRepos", default={}) or {}
    # Normalize day names to lowercase and ensure list values
    result: dict[str, list[str]] = {}
    for day, repos in raw.items():
        day_lower = day.lower()
        if day_lower in DAY_NAMES and isinstance(repos, list):
            result[day_lower] = [str(r) for r in repos]
    return result


def _parse_simple_yaml(path: Path) -> dict:
    """Minimal YAML parser for the flat structure of private.yaml.

    Only handles the specific structure we use — not a general YAML parser.
    Falls back to empty dict on any parse issues.
    """
    try:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except ImportError:
        pass

    # If PyYAML isn't available, return empty and rely on env vars
    import sys
    print(
        "[load_private_config] Warning: PyYAML not installed and config/private.yaml "
        "exists. Install PyYAML or set env vars instead.",
        file=sys.stderr,
    )
    return {}
