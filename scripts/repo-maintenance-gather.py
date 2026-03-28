#!/usr/bin/env python3
"""
Tier 0 gather script for the repo-maintenance pipeline.

Collects signals from all tracked repos and outputs WorkItem[] JSON to stdout.
Empty output (or []) means no items — pipeline stops at Tier 0 with $0 cost.

Data sources:
  1. repo_hygiene.py --json → dependabot alerts, open PRs/issues, CI status
  2. GitHub API → dependabot alert details (for semver classification)
  3. Sentry REST API → new/regressed issues (last 24h)
  4. GitHub Issues API → stale PRs and existing maintenance-labeled issues

All operations are read-only. No mutations happen in Tier 0.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", os.path.expanduser("~/Code")))
REPOS_JSON = WORKSPACE_ROOT / "data" / "repos.json"
REPO_HYGIENE_SCRIPT = WORKSPACE_ROOT / "scripts" / "repo_hygiene.py"

SENTRY_BASE_URL = os.environ.get("SENTRY_BASE_URL", "https://us.sentry.io")
SENTRY_ORG = os.environ.get("SENTRY_ORG", "your-sentry-org")


def _resolve_sentry_token() -> str:
    """Resolve SENTRY_AUTH_TOKEN from env, falling back to macOS Keychain."""
    token = os.environ.get("SENTRY_AUTH_TOKEN", "")
    if token:
        return token
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", "sentry-auth-token", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return ""


SENTRY_AUTH_TOKEN = _resolve_sentry_token()

# Mapping of GitHub repo slugs to Sentry project slugs.
# Repos with multiple Sentry projects get multiple entries (one per project).
# Override via SENTRY_REPO_MAP env var (JSON: {"owner/repo": ["sentry-project"]}).
SENTRY_REPO_MAP_DEFAULT: dict[str, list[str]] = {
    "YOUR-ORG/krobar-back": ["sentry-project-1"],
    "YOUR-ORG/krobar-front": ["sentry-project-2   "],
    "YOUR-ORG/sentry-project-3-front": ["sentry-project-3"],
    "YOUR-ORG/sentry-project-3-back": ["sentry-project-3-back", "sentry-project-5"],
}

STALE_PR_DAYS = int(os.environ.get("STALE_PR_DAYS", "7"))
CVE_URGENT_THRESHOLD = float(os.environ.get("CVE_URGENT_THRESHOLD", "7.0"))


def log(message: str) -> None:
    """Log to stderr (stdout is reserved for WorkItem[] JSON)."""
    print(f"[repo-maintenance-gather] {message}", file=sys.stderr, flush=True)


def run_command(
    args: list[str], timeout: int = 60, cwd: str | None = None
) -> str | None:
    """Run a command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        log(f"Command failed (exit {result.returncode}): {' '.join(args[:4])}...")
        if result.stderr.strip():
            log(f"  stderr: {result.stderr.strip()[:200]}")
        return None
    except subprocess.TimeoutExpired:
        log(f"Command timed out: {' '.join(args[:4])}...")
        return None
    except (FileNotFoundError, OSError) as err:
        log(f"Command error: {err}")
        return None


def load_repos() -> list[dict]:
    """Load repo inventory from data/repos.json."""
    if not REPOS_JSON.exists():
        log(f"Repo inventory not found: {REPOS_JSON}")
        return []
    try:
        return json.loads(REPOS_JSON.read_text())
    except (json.JSONDecodeError, OSError) as err:
        log(f"Failed to load repos.json: {err}")
        return []


def load_sentry_repo_map() -> dict[str, list[str]]:
    """Load the repo→Sentry project(s) mapping."""
    env_map = os.environ.get("SENTRY_REPO_MAP", "")
    if env_map:
        try:
            raw = json.loads(env_map)
            # Normalize: accept both string and list values
            normalized: dict[str, list[str]] = {}
            for k, v in raw.items():
                normalized[k] = v if isinstance(v, list) else [v]
            return normalized
        except json.JSONDecodeError:
            log("Invalid SENTRY_REPO_MAP JSON, using defaults")
    return {k: list(v) for k, v in SENTRY_REPO_MAP_DEFAULT.items()}


# ---------------------------------------------------------------------------
# Dependabot: semver classification
# ---------------------------------------------------------------------------

def classify_dependabot_alert(alert: dict) -> str:
    """
    Classify a dependabot alert using the dependency-analyst semver framework.

    Returns one of:
      - "auto-fixable"  (patch/minor with no breaking changes, safe to auto-merge)
      - "needs-plan"    (major bump, no auto-PR, or complex)
      - "urgent"        (CVE >= threshold regardless of semver)
    """
    # Check CVE severity first — overrides everything
    advisory = alert.get("security_advisory") or {}
    cvss = advisory.get("cvss", {})
    cvss_score = cvss.get("score", 0.0) if isinstance(cvss, dict) else 0.0
    severity = advisory.get("severity", "").lower()

    if cvss_score >= CVE_URGENT_THRESHOLD or severity in ("critical", "high"):
        return "urgent"

    # Check if there's an auto-created PR
    fix_pr = alert.get("security_update") or {}
    has_auto_pr = bool(fix_pr.get("pull_request"))

    if not has_auto_pr:
        # No auto-fix PR — needs manual intervention
        return "needs-plan"

    # Determine semver delta from the vulnerability version range
    vuln = alert.get("security_vulnerability") or {}
    first_patched = vuln.get("first_patched_version", {})
    patched_version = first_patched.get("identifier", "") if isinstance(first_patched, dict) else ""
    vulnerable_range = vuln.get("vulnerable_version_range", "")

    # If we can't determine the version delta, be conservative
    if not patched_version:
        return "needs-plan"

    # Simple heuristic: if the alert has a PR and severity is low/moderate,
    # treat as auto-fixable (patch/minor equivalent)
    if severity in ("low", "moderate", ""):
        return "auto-fixable"

    return "needs-plan"


def fetch_dependabot_details(owner: str, repo: str) -> list[dict]:
    """Fetch detailed dependabot alerts for a repo via gh API."""
    raw = run_command(
        [
            "gh", "api", "-X", "GET",
            f"repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100",
        ],
        timeout=30,
    )
    if not raw:
        return []
    try:
        data = json.loads(raw)
        # gh api returns error objects for 403/404 (dependabot disabled, repo not found)
        if isinstance(data, dict) and "message" in data:
            return []
        if isinstance(data, list):
            return data
        return []
    except json.JSONDecodeError:
        return []


# ---------------------------------------------------------------------------
# Sentry: new/regressed issues
# ---------------------------------------------------------------------------

def fetch_sentry_issues(project_slug: str) -> list[dict]:
    """Fetch unresolved Sentry issues from the last 24h."""
    if not SENTRY_AUTH_TOKEN or not SENTRY_ORG:
        return []

    try:
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError, URLError
        from urllib.parse import urlencode

        params = urlencode({
            "query": "is:unresolved firstSeen:-24h",
            "limit": "25",
            "sort": "freq",
        })
        url = f"{SENTRY_BASE_URL}/api/0/projects/{SENTRY_ORG}/{project_slug}/issues/?{params}"

        req = Request(url)
        req.add_header("Authorization", f"Bearer {SENTRY_AUTH_TOKEN}")
        req.add_header("Accept", "application/json")

        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else []

    except (HTTPError, URLError, json.JSONDecodeError, OSError) as err:
        log(f"Sentry fetch failed for {project_slug}: {err}")
        return []


# ---------------------------------------------------------------------------
# Stale PRs
# ---------------------------------------------------------------------------

def fetch_stale_prs(owner: str, repo: str) -> list[dict]:
    """Find open PRs with no review activity in STALE_PR_DAYS days."""
    raw = run_command(
        [
            "gh", "pr", "list",
            "--repo", f"{owner}/{repo}",
            "--state", "open",
            "--limit", "50",
            "--json", "number,title,author,updatedAt,url,isDraft,reviewDecision",
        ],
        timeout=20,
    )
    if not raw:
        return []
    try:
        prs = json.loads(raw)
    except json.JSONDecodeError:
        return []

    if not isinstance(prs, list):
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_PR_DAYS)
    stale = []
    for pr in prs:
        if pr.get("isDraft"):
            continue
        updated = pr.get("updatedAt", "")
        if not updated:
            continue
        try:
            updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            if updated_dt < cutoff:
                stale.append(pr)
        except ValueError:
            continue
    return stale


# ---------------------------------------------------------------------------
# Existing maintenance issues (state tracking)
# ---------------------------------------------------------------------------

def fetch_maintenance_issues(owner: str, repo: str) -> list[dict]:
    """Find GitHub issues with status:approved label (ready for fixing)."""
    raw = run_command(
        [
            "gh", "issue", "list",
            "--repo", f"{owner}/{repo}",
            "--state", "open",
            "--label", "status:approved",
            "--limit", "20",
            "--json", "number,title,url,labels,updatedAt",
        ],
        timeout=15,
    )
    if not raw:
        return []
    try:
        issues = json.loads(raw)
        return issues if isinstance(issues, list) else []
    except json.JSONDecodeError:
        return []


# ---------------------------------------------------------------------------
# Main gather
# ---------------------------------------------------------------------------

def gather_repo_hygiene() -> dict | None:
    """Run repo_hygiene.py and return parsed JSON output."""
    if not REPO_HYGIENE_SCRIPT.exists():
        log(f"repo_hygiene.py not found: {REPO_HYGIENE_SCRIPT}")
        return None

    raw = run_command(
        [
            "python3", str(REPO_HYGIENE_SCRIPT),
            "--all-workspace",
            "--json",
            "--no-progress",
            "--skip-branch-checks",
            "--skip-branch-policy",
            "--skip-cleanup",
        ],
        timeout=300,
        cwd=str(WORKSPACE_ROOT),
    )
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        log(f"Failed to parse repo_hygiene.py output: {err}")
        return None


def build_work_items() -> list[dict]:
    """Build the complete WorkItem[] list from all data sources."""
    items: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()
    repos = load_repos()
    sentry_map = load_sentry_repo_map()

    # Phase 1: Run repo_hygiene.py for supplementary data (CI status, branch health).
    # Note: repo_hygiene.py only discovers repos at the top level and first nesting
    # level due to git repo boundary stopping. repos.json is the source of truth
    # for which repos to scan.
    log("Phase 1: Running repo_hygiene.py for supplementary data...")
    hygiene_data = gather_repo_hygiene()
    hygiene_repos: dict[str, dict] = {}
    if hygiene_data and "repos" in hygiene_data:
        for repo_info in hygiene_data["repos"]:
            slug = repo_info.get("github_repo", "")
            if slug:
                hygiene_repos[slug] = repo_info

    # Phase 2: Per-repo signal collection using repos.json as source of truth.
    # repos.json includes parent project directories (krobar-project, sentry-project-3-project, etc.)
    # that aren't actual GitHub repos. We validate each by checking if gh can resolve it.
    # Failures are logged and skipped gracefully.
    log(f"Phase 2: Collecting signals from {len(repos)} repos...")
    for repo_entry in repos:
        owner = repo_entry["owner"]
        repo = repo_entry["repo"]
        slug = f"{owner}/{repo}"
        hygiene = hygiene_repos.get(slug, {})
        github = hygiene.get("github", {})

        # 2a: Dependabot alerts
        # Use hygiene count as hint, but always fetch if hygiene didn't cover this repo
        dependabot_count = github.get("dependabot_open_alerts", "unknown")
        should_fetch = (
            (isinstance(dependabot_count, int) and dependabot_count > 0)
            or dependabot_count == "unknown"
            or not github.get("ready")
        )
        if should_fetch:
            if isinstance(dependabot_count, int) and dependabot_count > 0:
                log(f"  {slug}: fetching {dependabot_count} dependabot alerts...")
            else:
                log(f"  {slug}: checking dependabot alerts...")
            alerts = fetch_dependabot_details(owner, repo)
            for alert in alerts:
                if not isinstance(alert, dict):
                    continue
                state = alert.get("state", "")
                if state != "open":
                    continue

                alert_number = alert.get("number", 0)
                advisory = alert.get("security_advisory") or {}
                classification = classify_dependabot_alert(alert)
                severity = advisory.get("severity", "unknown")
                summary_text = advisory.get("summary", "Dependabot alert")
                pkg = (alert.get("security_vulnerability") or {}).get("package", {})
                pkg_name = pkg.get("name", "unknown") if isinstance(pkg, dict) else "unknown"

                item_type = "dependabot-safe" if classification == "auto-fixable" else (
                    "dependabot-urgent" if classification == "urgent" else "dependabot-unsafe"
                )

                items.append({
                    "id": f"dependabot-{owner}-{repo}-{alert_number}",
                    "source": f"dependabot/{slug}",
                    "type": item_type,
                    "summary": f"[{severity}] {pkg_name}: {summary_text}",
                    "body": (
                        f"Repo: {slug}\n"
                        f"Alert: #{alert_number}\n"
                        f"Package: {pkg_name}\n"
                        f"Severity: {severity}\n"
                        f"Classification: {classification}\n"
                        f"Has auto-PR: {bool((alert.get('security_update') or {}).get('pull_request'))}"
                    ),
                    "metadata": {
                        "repo": slug,
                        "alertNumber": alert_number,
                        "package": pkg_name,
                        "severity": severity,
                        "classification": classification,
                        "cvss": (advisory.get("cvss") or {}).get("score"),
                        "url": alert.get("html_url", ""),
                    },
                    "timestamp": alert.get("created_at", now),
                })

        # 2b: Stale PRs
        stale_prs = fetch_stale_prs(owner, repo)
        for pr in stale_prs:
            pr_number = pr.get("number", 0)
            author = pr.get("author", {})
            author_login = author.get("login", "unknown") if isinstance(author, dict) else "unknown"
            items.append({
                "id": f"stale-pr-{owner}-{repo}-{pr_number}",
                "source": f"github-pr/{slug}",
                "type": "stale-pr",
                "summary": f"Stale PR #{pr_number}: {pr.get('title', 'Untitled')} (by {author_login})",
                "body": (
                    f"Repo: {slug}\n"
                    f"PR: #{pr_number}\n"
                    f"Last updated: {pr.get('updatedAt', 'unknown')}\n"
                    f"Review decision: {pr.get('reviewDecision', 'none')}\n"
                    f"URL: {pr.get('url', '')}"
                ),
                "metadata": {
                    "repo": slug,
                    "prNumber": pr_number,
                    "author": author_login,
                    "updatedAt": pr.get("updatedAt", ""),
                    "url": pr.get("url", ""),
                },
                "timestamp": pr.get("updatedAt", now),
            })

        # 2c: Existing maintenance issues ready for fixing
        planned_issues = fetch_maintenance_issues(owner, repo)
        for issue in planned_issues:
            issue_number = issue.get("number", 0)
            label_names = [
                l.get("name", "") for l in issue.get("labels", []) if isinstance(l, dict)
            ]
            # Skip if already in progress or staged
            if "status:in-progress" in label_names or "status:staged" in label_names:
                continue
            items.append({
                "id": f"planned-fix-{owner}-{repo}-{issue_number}",
                "source": f"github-issue/{slug}",
                "type": "planned-fix",
                "summary": f"Ready to fix #{issue_number}: {issue.get('title', 'Untitled')}",
                "body": f"Repo: {slug}\nIssue: #{issue_number}\nURL: {issue.get('url', '')}",
                "metadata": {
                    "repo": slug,
                    "issueNumber": issue_number,
                    "labels": label_names,
                    "url": issue.get("url", ""),
                },
                "timestamp": issue.get("updatedAt", now),
            })

        # 2d: CI failures on key branches (from hygiene data)
        branch_checks = github.get("branch_checks", {})
        for branch_name, check_info in branch_checks.items():
            if not isinstance(check_info, dict):
                continue
            failing = check_info.get("failing", [])
            for failure in failing:
                workflow = failure.get("workflow", "unknown")
                items.append({
                    "id": f"ci-failure-{owner}-{repo}-{branch_name}-{workflow}",
                    "source": f"github-ci/{slug}",
                    "type": "ci-failure",
                    "summary": f"CI failing: {slug} ({branch_name}) — {workflow}",
                    "body": (
                        f"Repo: {slug}\n"
                        f"Branch: {branch_name}\n"
                        f"Workflow: {workflow}\n"
                        f"URL: {failure.get('url', '')}"
                    ),
                    "metadata": {
                        "repo": slug,
                        "branch": branch_name,
                        "workflow": workflow,
                        "url": failure.get("url", ""),
                    },
                    "timestamp": now,
                })

    # Phase 3: Sentry issues
    if SENTRY_AUTH_TOKEN and SENTRY_ORG:
        total_projects = sum(len(projects) for projects in sentry_map.values())
        log(f"Phase 3: Fetching Sentry issues for {total_projects} projects across {len(sentry_map)} repos...")
        for repo_slug, sentry_projects in sentry_map.items():
            for sentry_project in sentry_projects:
                sentry_issues = fetch_sentry_issues(sentry_project)
                for issue in sentry_issues:
                    sentry_id = issue.get("id", "")
                    title = issue.get("title", "Unknown error")
                    culprit = issue.get("culprit", "")
                    count = issue.get("count", "0")
                    user_count = issue.get("userCount", 0)
                    level = issue.get("level", "error")
                    permalink = issue.get("permalink", "")

                    items.append({
                        "id": f"sentry-{sentry_project}-{sentry_id}",
                        "source": f"sentry/{sentry_project}",
                        "type": "sentry-regression",
                        "summary": f"[{level}] {title} ({count} events, {user_count} users)",
                        "body": (
                            f"Project: {sentry_project}\n"
                            f"Repo: {repo_slug}\n"
                            f"Culprit: {culprit}\n"
                            f"Events: {count}\n"
                            f"Users affected: {user_count}\n"
                            f"URL: {permalink}"
                        ),
                        "metadata": {
                            "repo": repo_slug,
                            "sentryId": sentry_id,
                            "sentryProject": sentry_project,
                            "level": level,
                            "eventCount": count,
                            "userCount": user_count,
                            "culprit": culprit,
                            "url": permalink,
                        },
                        "timestamp": issue.get("firstSeen", now),
                    })
    else:
        log("Phase 3: Skipping Sentry (no SENTRY_AUTH_TOKEN or SENTRY_ORG set)")

    log(f"Gather complete: {len(items)} items from {len(repos)} repos")
    return items


def main():
    items = build_work_items()
    json.dump(items, sys.stdout)


if __name__ == "__main__":
    main()
