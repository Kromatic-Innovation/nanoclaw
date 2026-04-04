"""Unit tests for Google wrapper credential loading.

Verifies that load_creds() correctly prioritizes 1Password over local files
for ALL accounts, and handles partial/missing credential scenarios.

Run with:
    cd /workspace/voltaire && python3 -m pytest scripts/tests/test_google_creds.py -v
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# google_drive_wrapper tests
# ---------------------------------------------------------------------------


class TestDriveWrapperLoadCreds:
    """Tests for google_drive_wrapper.load_creds (uses module-level _active_account)."""

    MODULE = "scripts.google_drive_wrapper"

    def _load_creds(self):
        """Import and call load_creds fresh."""
        import scripts.google_drive_wrapper as mod
        return mod.load_creds()

    def _set_account(self, account: str):
        import scripts.google_drive_wrapper as mod
        mod._active_account = account

    # 1. 1Password preferred over local file
    def test_load_creds_prefers_op_over_file(self):
        self._set_account("1")
        op_result = ("op_cid", "op_cs", "op_rt")
        file_result = ("file_cid", "file_cs", "file_rt")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=op_result) as mock_op,
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result) as mock_file,
        ):
            result = self._load_creds()
            assert result == op_result
            mock_op.assert_called_once()
            # File should NOT be consulted when 1Password succeeds
            mock_file.assert_not_called()

    # 2. Falls back to file when 1Password fails
    def test_load_creds_falls_back_to_file(self):
        self._set_account("1")
        file_result = ("file_cid", "file_cs", "file_rt")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result),
        ):
            result = self._load_creds()
            assert result == file_result

    # 3. Account 2 also checks 1Password first (this was the bug)
    def test_load_creds_account2_checks_op(self):
        self._set_account("2")
        op_result = ("op_cid_2", "op_cs_2", "op_rt_2")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=op_result) as mock_op,
            patch(f"{self.MODULE}._load_creds_from_file") as mock_file,
        ):
            result = self._load_creds()
            assert result == op_result
            mock_op.assert_called_once()
            mock_file.assert_not_called()

    # 4. Raises RuntimeError when neither source has credentials
    def test_load_creds_raises_when_no_source(self):
        self._set_account("1")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=None),
        ):
            with pytest.raises(RuntimeError, match="credentials not found"):
                self._load_creds()

    # 5. 1Password partial failure (has client_id but not refresh_token) falls through to file
    def test_load_creds_op_partial_failure(self):
        """When _load_creds_from_op returns None due to incomplete fields,
        load_creds should fall through to _load_creds_from_file."""
        self._set_account("1")
        file_result = ("file_cid", "file_cs", "file_rt")
        # _load_creds_from_op returns None when fields are incomplete
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result),
        ):
            result = self._load_creds()
            assert result == file_result

    # 5b. Verify partial 1Password fields at the _op_read level
    def test_load_creds_from_op_partial_fields_returns_none(self):
        """When 1Password has client_id but NOT refresh_token, _load_creds_from_op returns None."""
        self._set_account("1")

        def selective_op_read(uri: str) -> str | None:
            if "client-id" in uri or "client_id" in uri:
                return "some-client-id"
            if "client-secret" in uri or "client_secret" in uri:
                return "some-secret"
            # refresh_token missing
            return None

        with patch(f"{self.MODULE}._op_read", side_effect=selective_op_read):
            import scripts.google_drive_wrapper as mod
            result = mod._load_creds_from_op()
            assert result is None


# ---------------------------------------------------------------------------
# google_contacts_wrapper tests
# ---------------------------------------------------------------------------


class TestContactsWrapperLoadCreds:
    """Tests for google_contacts_wrapper.load_creds (account passed as parameter)."""

    MODULE = "scripts.google_contacts_wrapper"

    def _load_creds(self, account: str = "1"):
        import scripts.google_contacts_wrapper as mod
        return mod.load_creds(account)

    # 1. 1Password preferred over local file
    def test_load_creds_prefers_op_over_file(self):
        op_result = ("op_cid", "op_cs", "op_rt")
        file_result = ("file_cid", "file_cs", "file_rt")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=op_result) as mock_op,
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result) as mock_file,
        ):
            result = self._load_creds("1")
            assert result == op_result
            mock_op.assert_called_once_with("1")
            mock_file.assert_not_called()

    # 2. Falls back to file when 1Password fails
    def test_load_creds_falls_back_to_file(self):
        file_result = ("file_cid", "file_cs", "file_rt")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result) as mock_file,
        ):
            result = self._load_creds("1")
            assert result == file_result
            mock_file.assert_called_once_with("1")

    # 3. Account 2 also checks 1Password first
    def test_load_creds_account2_checks_op(self):
        op_result = ("op_cid_2", "op_cs_2", "op_rt_2")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=op_result) as mock_op,
            patch(f"{self.MODULE}._load_creds_from_file") as mock_file,
        ):
            result = self._load_creds("2")
            assert result == op_result
            mock_op.assert_called_once_with("2")
            mock_file.assert_not_called()

    # 4. Raises RuntimeError when neither source has credentials
    def test_load_creds_raises_when_no_source(self):
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=None),
        ):
            with pytest.raises(RuntimeError, match="credentials not found"):
                self._load_creds("1")

    # 5. 1Password partial failure falls through to file
    def test_load_creds_op_partial_failure(self):
        file_result = ("file_cid", "file_cs", "file_rt")
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None),
            patch(f"{self.MODULE}._load_creds_from_file", return_value=file_result),
        ):
            result = self._load_creds("2")
            assert result == file_result

    # 5b. Verify at _op_read level for contacts wrapper
    def test_load_creds_from_op_partial_fields_returns_none(self):
        """When 1Password has client_id but NOT refresh_token, _load_creds_from_op returns None."""

        def selective_op_read(uri: str) -> str | None:
            if "client-id" in uri or "client_id" in uri:
                return "some-client-id"
            if "client-secret" in uri or "client_secret" in uri:
                return "some-secret"
            return None

        with patch(f"{self.MODULE}._op_read", side_effect=selective_op_read):
            import scripts.google_contacts_wrapper as mod
            result = mod._load_creds_from_op("2")
            assert result is None

    # Contacts-specific: verify account parameter is forwarded correctly
    def test_load_creds_forwards_account_to_both_sources(self):
        """Ensures the account parameter reaches both _load_creds_from_op and _load_creds_from_file."""
        with (
            patch(f"{self.MODULE}._load_creds_from_op", return_value=None) as mock_op,
            patch(f"{self.MODULE}._load_creds_from_file", return_value=None) as mock_file,
        ):
            with pytest.raises(RuntimeError):
                self._load_creds("2")
            mock_op.assert_called_once_with("2")
            mock_file.assert_called_once_with("2")
