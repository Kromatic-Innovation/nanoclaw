"""Shared structured error helper for Google API wrappers.

Maps common error patterns to suggested remediation actions so agents
and humans know what to do when something fails.
"""

from __future__ import annotations


def structured_error(error: str) -> dict:
    """Build structured error dict with suggested_action based on error pattern."""
    result: dict[str, str] = {"error": error}

    e_lower = error.lower()

    if "invalid_grant" in e_lower:
        result["error_code"] = "invalid_grant"
        result["suggested_action"] = (
            "Refresh token is stale or revoked. "
            "Run: python3 scripts/google_reauth.py --account <N>"
        )
    elif "permission_denied" in e_lower or "insufficient" in e_lower:
        result["error_code"] = "permission_denied"
        result["suggested_action"] = (
            "OAuth token may lack required scopes. "
            "Re-authorize: python3 scripts/google_reauth.py --account <N>"
        )
    elif "op: command not found" in e_lower or "1password cli" in e_lower:
        result["error_code"] = "op_not_found"
        result["suggested_action"] = (
            "Install the 1Password CLI: "
            "https://developer.1password.com/docs/cli/get-started/"
        )
    elif "not found in 1password" in e_lower or "could not resolve" in e_lower:
        result["error_code"] = "op_item_missing"
        result["suggested_action"] = (
            "1Password item not found. Check vault 'Agent Tools' has the "
            "expected items. See docs/SECRETS-MANAGEMENT.md"
        )
    elif "token refresh failed" in e_lower:
        result["error_code"] = "token_refresh_failed"
        result["suggested_action"] = (
            "OAuth token refresh failed. Check client_id/client_secret in "
            "1Password. Run: python3 scripts/google_reauth.py"
        )
    elif "credentials not found" in e_lower:
        result["error_code"] = "no_credentials"
        result["suggested_action"] = (
            "No credentials found in 1Password or local files. "
            "Run: python3 scripts/google_reauth.py --account <N>"
        )
    elif "delete" in e_lower and "not permitted" in e_lower:
        result["error_code"] = "delete_blocked"
        result["suggested_action"] = (
            "DELETE operations are blocked by policy. "
            "Use move_file to relocate files instead."
        )

    return result
