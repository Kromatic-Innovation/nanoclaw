#!/usr/bin/env python3
"""
Action helpers for the repo-maintenance pipeline.

Provides subcommands that the Tier 2 container agent calls for deterministic
operations. Each subcommand wraps existing scripts and outputs structured JSON
so the agent doesn't need to reason about shell pipelines.

Usage:
  python3 repo-maintenance-actions.py auto-merge --repo owner/repo --pr 142
  python3 repo-maintenance-actions.py promote-staging --repo owner/repo
  python3 repo-maintenance-actions.py check-staging --repo owner/repo
  python3 repo-maintenance-actions.py create-issue --repo owner/repo --title "Fix X" --body-file /tmp/body.md --labels "maintenance:needs-plan"
  python3 repo-maintenance-actions.py add-label --repo owner/repo --issue 42 --labels "maintenance:staged"
  python3 repo-maintenance-actions.py status --repo owner/repo
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", os.path.expanduser("~/Code")))
SCRIPTS_DIR = WORKSPACE_ROOT / "scripts"
GH_WAIT_STATUS = SCRIPTS_DIR / "gh_wait_status.sh"


def output(result: dict) -> None:
    """Print structured JSON result to stdout."""
    json.dump(result, sys.stdout, indent=2)
    print()


def run(
    args: list[str], timeout: int = 300, cwd: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Run a command, returning the CompletedProcess."""
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=cwd,
    )


def find_repo_path(repo_slug: str) -> Path | None:
    """Find the local path for a repo slug (owner/repo) using data/repos.json."""
    repos_json = WORKSPACE_ROOT / "data" / "repos.json"
    if not repos_json.exists():
        return None
    try:
        repos = json.loads(repos_json.read_text())
        for entry in repos:
            slug = f"{entry['owner']}/{entry['repo']}"
            if slug == repo_slug:
                return WORKSPACE_ROOT / entry["path"]
        return None
    except (json.JSONDecodeError, KeyError):
        return None


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_auto_merge(args: argparse.Namespace) -> None:
    """Merge a dependabot PR if CI is green."""
    repo = args.repo
    pr_number = args.pr

    # Step 1: Check PR CI status
    pr_result = run(
        ["gh", "pr", "view", str(pr_number), "--repo", repo,
         "--json", "mergeable,statusCheckRollup,title,headRefName"],
        timeout=30,
    )
    if pr_result.returncode != 0:
        output({"status": "error", "action": "auto-merge",
                "error": f"Cannot view PR #{pr_number}: {pr_result.stderr.strip()}"})
        return

    try:
        pr_data = json.loads(pr_result.stdout)
    except json.JSONDecodeError:
        output({"status": "error", "action": "auto-merge",
                "error": "Failed to parse PR data"})
        return

    mergeable = pr_data.get("mergeable", "")
    title = pr_data.get("title", "")

    # Check if all status checks passed
    checks = pr_data.get("statusCheckRollup", [])
    failing_checks = [
        c for c in checks
        if isinstance(c, dict) and c.get("conclusion") not in ("SUCCESS", "NEUTRAL", "SKIPPED", None)
        and c.get("status") == "COMPLETED"
    ]
    pending_checks = [
        c for c in checks
        if isinstance(c, dict) and c.get("status") != "COMPLETED"
    ]

    if pending_checks:
        output({"status": "pending", "action": "auto-merge",
                "message": f"PR #{pr_number} has {len(pending_checks)} pending checks",
                "pr": pr_number, "title": title})
        return

    if failing_checks:
        names = [c.get("name", "unknown") for c in failing_checks[:5]]
        output({"status": "blocked", "action": "auto-merge",
                "message": f"PR #{pr_number} has failing checks: {', '.join(names)}",
                "pr": pr_number, "title": title, "failingChecks": names})
        return

    if mergeable == "CONFLICTING":
        output({"status": "blocked", "action": "auto-merge",
                "message": f"PR #{pr_number} has merge conflicts",
                "pr": pr_number, "title": title})
        return

    # Step 2: Merge the PR
    merge_result = run(
        ["gh", "pr", "merge", str(pr_number), "--repo", repo,
         "--squash", "--auto"],
        timeout=60,
    )
    if merge_result.returncode != 0:
        output({"status": "error", "action": "auto-merge",
                "error": f"Merge failed: {merge_result.stderr.strip()}",
                "pr": pr_number, "title": title})
        return

    output({"status": "success", "action": "auto-merge",
            "message": f"Merged PR #{pr_number}: {title}",
            "pr": pr_number, "title": title, "repo": repo})


def cmd_promote_staging(args: argparse.Namespace) -> None:
    """Promote develop to staging branch."""
    repo = args.repo
    repo_path = find_repo_path(repo)

    # Create a PR from develop to staging
    pr_result = run(
        ["gh", "pr", "create", "--repo", repo,
         "--base", "staging", "--head", "develop",
         "--title", "chore: promote develop to staging",
         "--body", "Automated promotion by repo-maintenance pipeline.",
         "--no-maintainer-edit"],
        timeout=30,
    )

    if pr_result.returncode != 0:
        stderr = pr_result.stderr.strip()
        # "already exists" means a PR is already open
        if "already exists" in stderr.lower():
            # Find the existing PR
            list_result = run(
                ["gh", "pr", "list", "--repo", repo,
                 "--base", "staging", "--head", "develop",
                 "--state", "open", "--json", "number,url", "--limit", "1"],
                timeout=15,
            )
            if list_result.returncode == 0:
                try:
                    prs = json.loads(list_result.stdout)
                    if prs:
                        output({"status": "exists", "action": "promote-staging",
                                "message": f"Staging PR already open: #{prs[0]['number']}",
                                "pr": prs[0]["number"], "url": prs[0]["url"]})
                        return
                except json.JSONDecodeError:
                    pass
        output({"status": "error", "action": "promote-staging",
                "error": f"Failed to create staging PR: {stderr}"})
        return

    # Extract PR URL from stdout
    pr_url = pr_result.stdout.strip()
    output({"status": "success", "action": "promote-staging",
            "message": f"Created staging PR: {pr_url}",
            "url": pr_url, "repo": repo})


def cmd_check_staging(args: argparse.Namespace) -> None:
    """Check staging branch CI and e2e status."""
    repo = args.repo

    # Get latest workflow runs on staging
    runs_result = run(
        ["gh", "run", "list", "--repo", repo,
         "--branch", "staging", "--limit", "5",
         "--json", "databaseId,workflowName,status,conclusion,url,createdAt"],
        timeout=20,
    )
    if runs_result.returncode != 0:
        output({"status": "error", "action": "check-staging",
                "error": f"Failed to list runs: {runs_result.stderr.strip()}"})
        return

    try:
        runs = json.loads(runs_result.stdout)
    except json.JSONDecodeError:
        output({"status": "error", "action": "check-staging",
                "error": "Failed to parse run data"})
        return

    if not runs:
        output({"status": "unknown", "action": "check-staging",
                "message": "No recent runs on staging branch"})
        return

    # Group by workflow, take latest
    latest: dict[str, dict] = {}
    for r in runs:
        name = r.get("workflowName", "unknown")
        if name not in latest:
            latest[name] = r

    failing = []
    pending = []
    passing = []
    for name, r in latest.items():
        status = r.get("status", "")
        conclusion = r.get("conclusion", "")
        entry = {"workflow": name, "status": status, "conclusion": conclusion,
                 "url": r.get("url", "")}
        if status in ("in_progress", "queued", "pending", "waiting", "requested"):
            pending.append(entry)
        elif conclusion in ("failure", "cancelled", "timed_out", "action_required"):
            failing.append(entry)
        elif conclusion == "success":
            passing.append(entry)

    if failing:
        output({"status": "failing", "action": "check-staging",
                "message": f"{len(failing)} workflow(s) failing on staging",
                "failing": failing, "passing": len(passing), "pending": len(pending)})
    elif pending:
        output({"status": "pending", "action": "check-staging",
                "message": f"{len(pending)} workflow(s) still running",
                "pending": pending, "passing": len(passing)})
    else:
        output({"status": "green", "action": "check-staging",
                "message": f"All {len(passing)} workflow(s) passing on staging",
                "passing": len(passing), "repo": repo})


def cmd_create_issue(args: argparse.Namespace) -> None:
    """Create a GitHub issue with labels."""
    repo = args.repo
    title = args.title
    labels = args.labels or ""

    # Build gh args
    gh_args = [
        "gh", "issue", "create",
        "--repo", repo,
        "--title", title,
    ]

    if args.body_file and os.path.exists(args.body_file):
        gh_args.extend(["--body-file", args.body_file])
    elif args.body:
        gh_args.extend(["--body", args.body])
    else:
        gh_args.extend(["--body", "Created by repo-maintenance pipeline."])

    if labels:
        gh_args.extend(["--label", labels])

    result = run(gh_args, timeout=30)
    if result.returncode != 0:
        stderr = result.stderr.strip()
        # Label might not exist yet
        if "label" in stderr.lower() and "not found" in stderr.lower():
            # Retry without labels
            gh_args_no_labels = [a for a in gh_args if a != "--label" and a != labels]
            result = run(gh_args_no_labels, timeout=30)
            if result.returncode != 0:
                output({"status": "error", "action": "create-issue",
                        "error": f"Failed: {result.stderr.strip()}"})
                return
        else:
            output({"status": "error", "action": "create-issue",
                    "error": f"Failed: {stderr}"})
            return

    issue_url = result.stdout.strip()
    output({"status": "success", "action": "create-issue",
            "message": f"Created issue: {issue_url}",
            "url": issue_url, "repo": repo, "title": title})


def cmd_add_label(args: argparse.Namespace) -> None:
    """Add labels to an existing issue or PR."""
    repo = args.repo
    issue = args.issue
    labels = args.labels

    result = run(
        ["gh", "issue", "edit", str(issue), "--repo", repo,
         "--add-label", labels],
        timeout=15,
    )
    if result.returncode != 0:
        output({"status": "error", "action": "add-label",
                "error": f"Failed: {result.stderr.strip()}"})
        return

    output({"status": "success", "action": "add-label",
            "message": f"Added labels '{labels}' to #{issue}",
            "issue": issue, "repo": repo})


def cmd_status(args: argparse.Namespace) -> None:
    """Quick health check for a repo."""
    repo = args.repo

    # Fetch open PRs, issues, and dependabot counts
    checks = {}

    pr_result = run(
        ["gh", "pr", "list", "--repo", repo, "--state", "open",
         "--json", "number", "--limit", "100"],
        timeout=15,
    )
    if pr_result.returncode == 0:
        try:
            checks["open_prs"] = len(json.loads(pr_result.stdout))
        except json.JSONDecodeError:
            checks["open_prs"] = "error"
    else:
        checks["open_prs"] = "error"

    issue_result = run(
        ["gh", "issue", "list", "--repo", repo, "--state", "open",
         "--json", "number", "--limit", "100"],
        timeout=15,
    )
    if issue_result.returncode == 0:
        try:
            checks["open_issues"] = len(json.loads(issue_result.stdout))
        except json.JSONDecodeError:
            checks["open_issues"] = "error"
    else:
        checks["open_issues"] = "error"

    dep_result = run(
        ["gh", "api", "-X", "GET",
         f"repos/{repo}/dependabot/alerts?state=open&per_page=1"],
        timeout=15,
    )
    if dep_result.returncode == 0:
        try:
            data = json.loads(dep_result.stdout)
            if isinstance(data, list):
                checks["dependabot_alerts"] = len(data)
            else:
                checks["dependabot_alerts"] = "disabled"
        except json.JSONDecodeError:
            checks["dependabot_alerts"] = "error"
    else:
        checks["dependabot_alerts"] = "error"

    output({"status": "success", "action": "status", "repo": repo, **checks})


def cmd_search_issues(args: argparse.Namespace) -> None:
    """Search for existing open issues to prevent duplicates."""
    repo = args.repo
    query = args.query

    result = run(
        ["gh", "issue", "list", "--repo", repo, "--state", "open",
         "--search", query, "--json", "number,title,url,labels", "--limit", "5"],
        timeout=15,
    )
    if result.returncode != 0:
        output({"status": "error", "action": "search-issues",
                "error": f"Search failed: {result.stderr.strip()}"})
        return

    try:
        issues = json.loads(result.stdout)
    except json.JSONDecodeError:
        issues = []

    if issues:
        output({"status": "found", "action": "search-issues",
                "message": f"Found {len(issues)} matching issue(s)",
                "issues": [{"number": i["number"], "title": i["title"],
                            "url": i["url"]} for i in issues],
                "repo": repo, "query": query})
    else:
        output({"status": "none", "action": "search-issues",
                "message": "No matching issues found",
                "repo": repo, "query": query})


def cmd_check_test_coverage(args: argparse.Namespace) -> None:
    """Check if a repo has test infrastructure (test dirs, Playwright, CI test workflows)."""
    repo = args.repo
    repo_path = find_repo_path(f"{repo}")

    signals = {
        "has_test_dirs": False,
        "has_playwright": False,
        "has_ci_tests": False,
        "details": [],
    }

    if not repo_path or not repo_path.exists():
        # Fall back to checking via GitHub API
        # Check for test workflows
        wf_result = run(
            ["gh", "api", f"repos/{repo}/actions/workflows", "--jq",
             ".workflows[].name"],
            timeout=15,
        )
        if wf_result.returncode == 0 and wf_result.stdout.strip():
            workflow_names = wf_result.stdout.strip().lower()
            if any(kw in workflow_names for kw in ["test", "ci", "check", "lint"]):
                signals["has_ci_tests"] = True
                signals["details"].append("CI test workflows found")
            if "playwright" in workflow_names or "e2e" in workflow_names:
                signals["has_playwright"] = True
                signals["details"].append("Playwright/e2e workflow found")

        output({"status": "success", "action": "check-test-coverage",
                "repo": repo, **signals})
        return

    # Check local filesystem
    test_patterns = ["tests", "test", "__tests__", "spec", "specs"]
    for pattern in test_patterns:
        for match in repo_path.rglob(pattern):
            if match.is_dir() and "node_modules" not in str(match):
                signals["has_test_dirs"] = True
                signals["details"].append(f"Test dir: {match.relative_to(repo_path)}")
                break
        if signals["has_test_dirs"]:
            break

    # Check for Playwright
    pw_markers = ["playwright.config.ts", "playwright.config.js",
                  "playwright.config.mjs"]
    for marker in pw_markers:
        if list(repo_path.rglob(marker)):
            signals["has_playwright"] = True
            signals["details"].append("Playwright config found")
            break

    # Check for CI test workflows
    workflows_dir = repo_path / ".github" / "workflows"
    if workflows_dir.exists():
        for wf in workflows_dir.glob("*.yml"):
            name = wf.stem.lower()
            if any(kw in name for kw in ["test", "ci", "check", "lint"]):
                signals["has_ci_tests"] = True
                signals["details"].append(f"CI workflow: {wf.name}")
                break

    output({"status": "success", "action": "check-test-coverage",
            "repo": repo, **signals})


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Repo maintenance action helpers for the pipeline Tier 2 agent."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # auto-merge
    p_merge = subparsers.add_parser("auto-merge", help="Merge a dependabot PR if CI green")
    p_merge.add_argument("--repo", required=True, help="owner/repo slug")
    p_merge.add_argument("--pr", required=True, type=int, help="PR number")

    # promote-staging
    p_promote = subparsers.add_parser("promote-staging", help="Promote develop to staging")
    p_promote.add_argument("--repo", required=True, help="owner/repo slug")

    # check-staging
    p_check = subparsers.add_parser("check-staging", help="Check staging CI/e2e status")
    p_check.add_argument("--repo", required=True, help="owner/repo slug")

    # create-issue
    p_issue = subparsers.add_parser("create-issue", help="Create a GitHub issue")
    p_issue.add_argument("--repo", required=True, help="owner/repo slug")
    p_issue.add_argument("--title", required=True, help="Issue title")
    p_issue.add_argument("--body", help="Issue body text")
    p_issue.add_argument("--body-file", help="Path to file with issue body")
    p_issue.add_argument("--labels", help="Comma-separated labels")

    # add-label
    p_label = subparsers.add_parser("add-label", help="Add labels to an issue/PR")
    p_label.add_argument("--repo", required=True, help="owner/repo slug")
    p_label.add_argument("--issue", required=True, type=int, help="Issue/PR number")
    p_label.add_argument("--labels", required=True, help="Comma-separated labels")

    # status
    p_status = subparsers.add_parser("status", help="Quick repo health check")
    p_status.add_argument("--repo", required=True, help="owner/repo slug")

    # search-issues
    p_search = subparsers.add_parser("search-issues", help="Search open issues for dedup")
    p_search.add_argument("--repo", required=True, help="owner/repo slug")
    p_search.add_argument("--query", required=True, help="Search query string")

    # check-test-coverage
    p_coverage = subparsers.add_parser("check-test-coverage", help="Check repo test infrastructure")
    p_coverage.add_argument("--repo", required=True, help="owner/repo slug")

    args = parser.parse_args()

    commands = {
        "auto-merge": cmd_auto_merge,
        "promote-staging": cmd_promote_staging,
        "check-staging": cmd_check_staging,
        "create-issue": cmd_create_issue,
        "add-label": cmd_add_label,
        "status": cmd_status,
        "search-issues": cmd_search_issues,
        "check-test-coverage": cmd_check_test_coverage,
    }

    try:
        commands[args.command](args)
    except subprocess.TimeoutExpired:
        output({"status": "error", "action": args.command,
                "error": "Command timed out"})
        sys.exit(1)
    except Exception as err:
        output({"status": "error", "action": args.command,
                "error": str(err)})
        sys.exit(1)


if __name__ == "__main__":
    main()
