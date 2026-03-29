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
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", os.path.expanduser("~/Code")))
REPOS_JSON = WORKSPACE_ROOT / "data" / "repos.json"
REPO_HYGIENE_SCRIPT = WORKSPACE_ROOT / "scripts" / "repo_hygiene.py"

# Load org-specific config from config/private.yaml (gitignored).
# Falls back to environment variables if the file doesn't exist.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_private_config import load_private_config
_PRIVATE = load_private_config()

SENTRY_BASE_URL = _PRIVATE["sentry"]["baseUrl"]
SENTRY_ORG = _PRIVATE["sentry"]["org"]

# Frequency tiers: daily repos get full scan every run.
# Weekly repos get full scan on Thursdays, urgent-only (dependabot + Sentry) other days.
DAILY_REPOS: set[str] = _PRIVATE["repoMaintenance"]["dailyRepos"]
WEEKLY_DAY: int = _PRIVATE["repoMaintenance"]["weeklyDay"]


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
# Loaded from config/private.yaml; override via SENTRY_REPO_MAP env var (JSON).
SENTRY_REPO_MAP_DEFAULT: dict[str, list[str]] = _PRIVATE["sentry"]["repoMap"]

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
# Test coverage detection
# ---------------------------------------------------------------------------

def detect_test_coverage(owner: str, repo: str, repo_path: Path | None) -> dict:
    """Detect test infrastructure for a repo. Used for auto-fix heuristics."""
    coverage = {"has_tests": False, "has_playwright": False, "has_ci_tests": False}

    if repo_path and repo_path.exists():
        # Check local filesystem (fast)
        test_dirs = ["tests", "test", "__tests__", "spec", "specs"]
        for td in test_dirs:
            for match in repo_path.rglob(td):
                if match.is_dir() and "node_modules" not in str(match):
                    coverage["has_tests"] = True
                    break
            if coverage["has_tests"]:
                break

        pw_configs = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]
        for pc in pw_configs:
            if list(repo_path.rglob(pc)):
                coverage["has_playwright"] = True
                break

        wf_dir = repo_path / ".github" / "workflows"
        if wf_dir.exists():
            for wf in wf_dir.glob("*.yml"):
                if any(kw in wf.stem.lower() for kw in ["test", "ci", "check"]):
                    coverage["has_ci_tests"] = True
                    break

    return coverage


# ---------------------------------------------------------------------------
# Existing maintenance issues (state tracking)
# ---------------------------------------------------------------------------

def fetch_untriaged_issues(owner: str, repo: str) -> list[dict]:
    """Find open issues that have no status:* label (ideas, feedback, untriaged)."""
    raw = run_command(
        [
            "gh", "issue", "list",
            "--repo", f"{owner}/{repo}",
            "--state", "open",
            "--limit", "50",
            "--json", "number,title,url,labels,updatedAt,body",
        ],
        timeout=20,
    )
    if not raw:
        return []
    try:
        issues = json.loads(raw)
        if not isinstance(issues, list):
            return []
    except json.JSONDecodeError:
        return []

    untriaged = []
    for issue in issues:
        label_names = [
            l.get("name", "") for l in issue.get("labels", []) if isinstance(l, dict)
        ]
        # Skip issues that already have a status label (already in the pipeline)
        has_status = any(l.startswith("status:") for l in label_names)
        # Skip issues that have a type label (already classified)
        has_type = any(l.startswith("type:") for l in label_names)
        # Skip moscow:wont issues (explicitly deprioritized)
        is_wont = "moscow:wont" in label_names
        if not has_status and not has_type and not is_wont:
            untriaged.append(issue)
    return untriaged


def fetch_maintenance_issues(owner: str, repo: str) -> list[dict]:
    """Find GitHub issues with status:approved label (ready for fixing)."""
    raw = run_command(
        [
            "gh", "issue", "list",
            "--repo", f"{owner}/{repo}",
            "--state", "open",
            "--label", "status:approved",
            "--limit", "20",
            "--json", "number,title,url,labels,updatedAt,body",
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


def fetch_issue_comments(owner: str, repo: str, issue_number: int, limit: int = 3) -> list[dict]:
    """Fetch the latest N comments on a GitHub issue."""
    raw = run_command(
        [
            "gh", "issue", "view",
            str(issue_number),
            "--repo", f"{owner}/{repo}",
            "--json", "comments",
        ],
        timeout=15,
    )
    if not raw:
        return []
    try:
        data = json.loads(raw)
        comments = data.get("comments", [])
        if not isinstance(comments, list):
            return []
        # Return the last N comments (author + body, truncated)
        return [
            {
                "author": c.get("author", {}).get("login", "unknown"),
                "body": (c.get("body", "") or "")[:500],
                "createdAt": c.get("createdAt", ""),
            }
            for c in comments[-limit:]
        ]
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


def build_work_items(
    repo_filter: str | None = None,
    skip_hygiene: bool = False,
    tier: str = "auto",
) -> list[dict]:
    """Build the complete WorkItem[] list from all data sources.

    Tier modes:
      - "auto": daily repos get full scan; weekly repos get full scan on
        WEEKLY_DAY (Thursday), urgent-only other days.
      - "daily": only scan daily-tier repos (full scan).
      - "weekly": only scan weekly-tier repos (full scan).
      - "all": full scan on all repos regardless of day.
    """
    items: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()
    repos = load_repos()
    sentry_map = load_sentry_repo_map()

    # Filter to a single repo if requested
    if repo_filter:
        repos = [r for r in repos if f"{r['owner']}/{r['repo']}" == repo_filter]
        sentry_map = {k: v for k, v in sentry_map.items() if k == repo_filter}
        if not repos:
            log(f"No repo matching '{repo_filter}' in repos.json")
            return []
        log(f"Filtered to single repo: {repo_filter}")
        urgent_only_slugs: set[str] = set()
    elif tier == "all":
        urgent_only_slugs = set()
    else:
        # Apply frequency tier filtering
        today_weekday = datetime.now(timezone.utc).weekday()
        is_weekly_day = today_weekday == WEEKLY_DAY

        daily_repos = []
        weekly_repos_full = []
        weekly_repos_urgent = []

        for r in repos:
            slug = f"{r['owner']}/{r['repo']}"
            if slug in DAILY_REPOS:
                daily_repos.append(r)
            elif tier == "weekly" or is_weekly_day:
                weekly_repos_full.append(r)
            else:
                weekly_repos_urgent.append(r)

        if tier == "daily":
            repos = daily_repos
            log(f"Daily tier: scanning {len(repos)} repos (full)")
        elif tier == "weekly":
            repos = weekly_repos_full + weekly_repos_urgent
            sentry_map = {k: v for k, v in sentry_map.items() if k not in DAILY_REPOS}
            log(f"Weekly tier: scanning {len(repos)} repos (full)")
        else:  # auto
            if is_weekly_day:
                repos = daily_repos + weekly_repos_full
                log(f"Auto tier (Thursday): scanning {len(daily_repos)} daily + {len(weekly_repos_full)} weekly repos (full)")
            else:
                # Tag weekly repos for urgent-only scan
                repos = daily_repos + weekly_repos_urgent
                log(f"Auto tier: scanning {len(daily_repos)} daily (full) + {len(weekly_repos_urgent)} weekly (urgent-only)")

        # Track which repos are urgent-only (skip stale PRs, untriaged issues)
        urgent_only_slugs = {f"{r['owner']}/{r['repo']}" for r in weekly_repos_urgent}

    # Phase 1: Run repo_hygiene.py for supplementary data (CI status, branch health).
    # Note: repo_hygiene.py only discovers repos at the top level and first nesting
    # level due to git repo boundary stopping. repos.json is the source of truth
    # for which repos to scan.
    hygiene_data = None
    if skip_hygiene:
        log("Phase 1: Skipping repo_hygiene.py (--skip-hygiene)")
    else:
        log("Phase 1: Running repo_hygiene.py for supplementary data...")
        hygiene_data = gather_repo_hygiene()
    hygiene_repos: dict[str, dict] = {}
    if hygiene_data and "repos" in hygiene_data:
        for repo_info in hygiene_data["repos"]:
            slug = repo_info.get("github_repo", "")
            if slug:
                hygiene_repos[slug] = repo_info

    # Phase 2: Per-repo signal collection using repos.json as source of truth.
    # repos.json includes parent project directories (e.g. krobar-project, orca-project)
    # that aren't actual GitHub repos. We validate each by checking if gh can resolve it.
    # Failures are logged and skipped gracefully.
    log(f"Phase 2: Collecting signals from {len(repos)} repos...")
    for repo_entry in repos:
        owner = repo_entry["owner"]
        repo = repo_entry["repo"]
        slug = f"{owner}/{repo}"
        hygiene = hygiene_repos.get(slug, {})
        github = hygiene.get("github", {})
        repo_path = WORKSPACE_ROOT / repo_entry.get("path", "")
        test_coverage = detect_test_coverage(owner, repo, repo_path)

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
                        "testCoverage": test_coverage,
                    },
                    "timestamp": alert.get("created_at", now),
                })

        # 2b: Stale PRs (skip for urgent-only repos)
        if slug in urgent_only_slugs:
            stale_prs = []
        else:
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
                    "testCoverage": test_coverage,
                },
                "timestamp": pr.get("updatedAt", now),
            })

        # 2c: Existing maintenance issues ready for fixing (skip for urgent-only repos)
        if slug in urgent_only_slugs:
            planned_issues = []
        else:
            planned_issues = fetch_maintenance_issues(owner, repo)
        for issue in planned_issues:
            issue_number = issue.get("number", 0)
            label_names = [
                l.get("name", "") for l in issue.get("labels", []) if isinstance(l, dict)
            ]
            # Skip if already in progress or staged
            if "status:in-progress" in label_names or "status:staged" in label_names:
                continue
            issue_body = issue.get("body", "") or ""
            has_existing_plan = "## Implementation Plan" in issue_body or "## implementation plan" in issue_body.lower()
            comments = fetch_issue_comments(owner, repo, issue_number)
            comments_text = ""
            if comments:
                comments_text = "\n\n## Recent Comments\n" + "\n".join(
                    f"- @{c['author']} ({c['createdAt']}): {c['body']}"
                    for c in comments
                )
            items.append({
                "id": f"planned-fix-{owner}-{repo}-{issue_number}",
                "source": f"github-issue/{slug}",
                "type": "planned-fix",
                "summary": f"Ready to fix #{issue_number}: {issue.get('title', 'Untitled')}",
                "body": (
                    f"Repo: {slug}\n"
                    f"Issue: #{issue_number}\n"
                    f"URL: {issue.get('url', '')}\n\n"
                    f"## Existing Issue Body\n{issue_body[:2000]}"
                    f"{comments_text}"
                ),
                "metadata": {
                    "repo": slug,
                    "issueNumber": issue_number,
                    "labels": label_names,
                    "url": issue.get("url", ""),
                    "testCoverage": test_coverage,
                    "hasExistingPlan": has_existing_plan,
                    "bodyLength": len(issue_body),
                },
                "timestamp": issue.get("updatedAt", now),
            })

        # 2d: Untriaged issues (skip for urgent-only repos)
        if slug in urgent_only_slugs:
            untriaged = []
        else:
            untriaged = fetch_untriaged_issues(owner, repo)
        for issue in untriaged:
            issue_number = issue.get("number", 0)
            issue_body = issue.get("body", "") or ""
            label_names = [
                l.get("name", "") for l in issue.get("labels", []) if isinstance(l, dict)
            ]
            comments = fetch_issue_comments(owner, repo, issue_number)
            comments_text = ""
            if comments:
                comments_text = "\n\n## Recent Comments\n" + "\n".join(
                    f"- @{c['author']} ({c['createdAt']}): {c['body']}"
                    for c in comments
                )
            items.append({
                "id": f"untriaged-{owner}-{repo}-{issue_number}",
                "source": f"github-issue/{slug}",
                "type": "untriaged-issue",
                "summary": f"Untriaged #{issue_number}: {issue.get('title', 'Untitled')}",
                "body": (
                    f"Repo: {slug}\n"
                    f"Issue: #{issue_number}\n"
                    f"URL: {issue.get('url', '')}\n\n"
                    f"## Issue Body\n{issue_body[:2000]}"
                    f"{comments_text}"
                ),
                "metadata": {
                    "repo": slug,
                    "issueNumber": issue_number,
                    "labels": label_names,
                    "url": issue.get("url", ""),
                    "bodyLength": len(issue_body),
                    "testCoverage": test_coverage,
                },
                "timestamp": issue.get("updatedAt", now),
            })

        # 2e: CI failures on key branches (from hygiene data)
        branch_checks = github.get("branch_checks", {})
        for branch_name, check_info in branch_checks.items():
            if not isinstance(check_info, dict):
                continue
            failing = check_info.get("failing", [])
            for failure in failing:
                workflow = failure.get("workflow", "unknown")
                wf_lower = workflow.lower()
                # Classify failure type: test failures are auto-fixable,
                # build/deploy failures need human review
                failure_type = "test" if any(
                    kw in wf_lower for kw in ["test", "spec", "check", "lint", "e2e", "playwright"]
                ) else "build"
                items.append({
                    "id": f"ci-failure-{owner}-{repo}-{branch_name}-{workflow}",
                    "source": f"github-ci/{slug}",
                    "type": "ci-failure",
                    "summary": f"CI failing: {slug} ({branch_name}) — {workflow}",
                    "body": (
                        f"Repo: {slug}\n"
                        f"Branch: {branch_name}\n"
                        f"Workflow: {workflow}\n"
                        f"Failure type: {failure_type}\n"
                        f"URL: {failure.get('url', '')}"
                    ),
                    "metadata": {
                        "repo": slug,
                        "branch": branch_name,
                        "workflow": workflow,
                        "failureType": failure_type,
                        "url": failure.get("url", ""),
                        "testCoverage": test_coverage,
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
                            "testCoverage": detect_test_coverage(
                                *repo_slug.split("/", 1),
                                WORKSPACE_ROOT / next(
                                    (r["path"] for r in repos if f"{r['owner']}/{r['repo']}" == repo_slug),
                                    "",
                                ),
                            ),
                        },
                        "timestamp": issue.get("firstSeen", now),
                    })
    else:
        log("Phase 3: Skipping Sentry (no SENTRY_AUTH_TOKEN or SENTRY_ORG set)")

    log(f"Gather complete: {len(items)} items from {len(repos)} repos")
    return items


def main():
    import argparse
    import traceback

    parser = argparse.ArgumentParser(description="Tier 0 gather for repo-maintenance pipeline")
    parser.add_argument("--repo", help="Single repo slug (owner/repo) to scan instead of all")
    parser.add_argument("--skip-hygiene", action="store_true", help="Skip repo_hygiene.py (faster)")
    parser.add_argument("--preflight-done", action="store_true", help="Preflight already ran hygiene checks; skip them here (same as --skip-hygiene)")
    parser.add_argument(
        "--tier", choices=["auto", "daily", "weekly", "all"], default="auto",
        help="Frequency tier: auto (daily repos + urgent-only weekly), daily, weekly, or all",
    )
    args = parser.parse_args()

    try:
        items = build_work_items(repo_filter=args.repo, skip_hygiene=args.skip_hygiene or args.preflight_done, tier=args.tier)
    except Exception as err:
        # Always output valid JSON so the pipeline continues with an error item
        log(f"FATAL: {err}")
        traceback.print_exc(file=sys.stderr)
        items = [{
            "id": "gather-error",
            "source": "repo-maintenance-gather",
            "type": "ci-failure",
            "summary": f"Gather script crashed: {err}",
            "body": f"The repo-maintenance gather script failed with:\n\n```\n{traceback.format_exc()}\n```\n\nPartial results may be missing.",
            "metadata": {"repo": "nanoclaw", "failureType": "build"},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }]
    json.dump(items, sys.stdout)


if __name__ == "__main__":
    main()
