"""Parametrised tests for airdrop_pulse input validation (Issue #969).

Security: a crafted recipients list must never be able to reduce the computed
total below the approval threshold so that large transfers bypass approval.

Coverage:
- Negative/zero/non-numeric amounts cause rejection without any transfer.
- Mixed lists containing at least one bad entry cause whole-call rejection.
- Totals that genuinely exceed the threshold still go through approval.
- Valid lists below threshold execute transfers normally.
- The recipient cap is enforced.
"""

from __future__ import annotations

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from talos_agent.tools.stellar import _validate_airdrop_recipients, _AIRDROP_MAX_RECIPIENTS

# A valid Stellar testnet G-address used throughout
_VALID_ACCT = "GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXE7EV4EVOTVEVMHGHLJLMV"
_VALID_ACCT_2 = "GDQVLMT7YWKCZWW22XFOVN6VJYJ4OKWPMZXJJRGJPBHCMHGQASXNHQF"


# ── _validate_airdrop_recipients unit tests ────────────────────────────────


class TestValidateAirdropRecipients:
    """Unit tests for the validator helper directly."""

    # --- Happy-path cases ---

    def test_single_valid_entry(self):
        entries = [{"account": _VALID_ACCT, "amount": 100}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is None
        assert len(validated) == 1
        assert validated[0]["amount"] == 100.0

    def test_multiple_valid_entries(self):
        entries = [
            {"account": _VALID_ACCT, "amount": 50},
            {"account": _VALID_ACCT_2, "amount": 75.5},
        ]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is None
        assert len(validated) == 2

    def test_amount_as_string_float(self):
        """String-encoded numeric amounts are accepted."""
        entries = [{"account": _VALID_ACCT, "amount": "42.5"}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is None
        assert validated[0]["amount"] == 42.5

    # --- Rejection cases (negative / zero / non-numeric amounts) ---

    @pytest.mark.parametrize(
        "bad_amount",
        [
            -1,
            -0.01,
            -1000,
            0,
            0.0,
            "abc",
            "",
            None,
            float("inf"),
            float("nan"),
            True,   # bool is a subtype of int but must be rejected
            False,
        ],
    )
    def test_invalid_amount_causes_rejection(self, bad_amount):
        entries = [{"account": _VALID_ACCT, "amount": bad_amount}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is not None, f"expected rejection for amount={bad_amount!r}"
        assert validated == []

    def test_missing_amount_causes_rejection(self):
        entries = [{"account": _VALID_ACCT}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is not None
        assert "amount" in err

    def test_negative_entry_mixed_with_valid_causes_whole_rejection(self):
        """A single bad entry must cause rejection of the entire call."""
        entries = [
            {"account": _VALID_ACCT, "amount": 1000},
            {"account": _VALID_ACCT_2, "amount": -995},  # attacker entry
        ]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is not None
        assert validated == []

    # --- Account validation ---

    @pytest.mark.parametrize(
        "bad_account",
        [
            "",
            "not-a-stellar-account",
            "SXXX",                    # secret key prefix
            "../../../etc/passwd",     # path traversal
            "GXXX",                    # too short G-address
        ],
    )
    def test_invalid_account_causes_rejection(self, bad_account):
        entries = [{"account": bad_account, "amount": 10}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is not None
        assert validated == []

    def test_missing_account_causes_rejection(self):
        entries = [{"amount": 10}]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is not None

    # --- Structure validation ---

    def test_non_list_rejected(self):
        _, err = _validate_airdrop_recipients({"account": _VALID_ACCT, "amount": 100})
        assert err is not None and "array" in err

    def test_non_dict_entry_rejected(self):
        _, err = _validate_airdrop_recipients(["not-a-dict"])
        assert err is not None and "object" in err

    def test_empty_list_rejected(self):
        _, err = _validate_airdrop_recipients([])
        assert err is not None and "empty" in err

    # --- Recipient cap ---

    def test_over_cap_rejected(self):
        entries = [
            {"account": _VALID_ACCT, "amount": 1}
            for _ in range(_AIRDROP_MAX_RECIPIENTS + 1)
        ]
        _, err = _validate_airdrop_recipients(entries)
        assert err is not None and "cap" in err.lower()

    def test_exactly_at_cap_accepted(self):
        entries = [
            {"account": _VALID_ACCT, "amount": 1}
            for _ in range(_AIRDROP_MAX_RECIPIENTS)
        ]
        validated, err = _validate_airdrop_recipients(entries)
        assert err is None
        assert len(validated) == _AIRDROP_MAX_RECIPIENTS


# ── airdrop_pulse integration tests ──────────────────────────────────────────


def _make_mock_api():
    api = AsyncMock()
    api.create_approval = AsyncMock(return_value={"id": "appr-001"})
    api.request_transfer = AsyncMock(return_value={"status": "ok"})
    return api


def _make_mock_settings(threshold: float = 10.0):
    settings = MagicMock()
    settings.approval_threshold = threshold
    settings.talos_id = "test-talos-id"
    return settings


class TestAirdropPulseIntegration:
    """Integration tests for the airdrop_pulse tool function."""

    @pytest.mark.asyncio
    async def test_negative_amount_rejected_no_transfer(self):
        """Negative amount entries must not trigger any transfer call."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=10000.0)  # very high threshold

        with (
            patch("talos_agent.tools.stellar._api", mock_api),
            patch("talos_agent.tools.stellar._settings", mock_settings),
            patch("talos_agent.tools.stellar._context.resolve") as mock_resolve,
        ):
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": -500},
                ]),
            )

        assert "error" in result
        mock_api.request_transfer.assert_not_called()
        mock_api.create_approval.assert_not_called()

    @pytest.mark.asyncio
    async def test_zero_amount_rejected_no_transfer(self):
        """Zero amount entries must be rejected."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=10000.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": 0},
                ]),
            )

        assert "error" in result
        mock_api.request_transfer.assert_not_called()

    @pytest.mark.asyncio
    async def test_negative_mixed_with_large_positive_rejected(self):
        """[{amount: 1000}, {amount: -995}] must be rejected; approval must not be bypassed."""
        mock_api = _make_mock_api()
        # Threshold is 10 — net 5 would slip under it; full 1000 should require approval
        mock_settings = _make_mock_settings(threshold=10.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": 1000},
                    {"account": _VALID_ACCT_2, "amount": -995},
                ]),
            )

        # Whole call must be rejected — no approval, no transfer
        assert "error" in result
        mock_api.create_approval.assert_not_called()
        mock_api.request_transfer.assert_not_called()

    @pytest.mark.asyncio
    async def test_above_threshold_requests_approval(self):
        """Valid list whose total exceeds threshold must request approval."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=10.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": 50},
                    {"account": _VALID_ACCT_2, "amount": 75},
                ]),
            )

        assert result["status"] == "approval_requested"
        assert result["approval_id"] == "appr-001"
        mock_api.create_approval.assert_called_once()
        mock_api.request_transfer.assert_not_called()

    @pytest.mark.asyncio
    async def test_below_threshold_executes_transfers(self):
        """Valid list whose total is below threshold must execute transfers directly."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=1000.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": 5},
                    {"account": _VALID_ACCT_2, "amount": 3},
                ]),
            )

        assert result["status"] == "completed"
        assert len(result["transfers"]) == 2
        mock_api.create_approval.assert_not_called()
        assert mock_api.request_transfer.call_count == 2

    @pytest.mark.asyncio
    async def test_non_numeric_amount_rejected(self):
        """Non-numeric 'amount' string must be rejected without any transfer."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=10000.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps([
                    {"account": _VALID_ACCT, "amount": "not-a-number"},
                ]),
            )

        assert "error" in result
        mock_api.request_transfer.assert_not_called()

    @pytest.mark.asyncio
    async def test_invalid_json_returns_error(self):
        """Malformed JSON recipients string must return an error dict."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings()

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            result = await airdrop_pulse(
                token_id="PULSE",
                recipients="{{not valid json",
            )

        assert "error" in result
        mock_api.request_transfer.assert_not_called()

    @pytest.mark.asyncio
    async def test_recipient_cap_enforced(self):
        """Requests with more than _AIRDROP_MAX_RECIPIENTS entries are rejected."""
        mock_api = _make_mock_api()
        mock_settings = _make_mock_settings(threshold=1_000_000.0)

        with patch("talos_agent.tools.stellar._context.resolve") as mock_resolve:
            ctx = MagicMock()
            ctx.api = mock_api
            ctx.settings = mock_settings
            ctx.stellar_kit = None
            mock_resolve.return_value = ctx

            from talos_agent.tools.stellar import airdrop_pulse

            oversized = [
                {"account": _VALID_ACCT, "amount": 1}
                for _ in range(_AIRDROP_MAX_RECIPIENTS + 1)
            ]
            result = await airdrop_pulse(
                token_id="PULSE",
                recipients=json.dumps(oversized),
            )

        assert "error" in result
        mock_api.request_transfer.assert_not_called()
        mock_api.create_approval.assert_not_called()
