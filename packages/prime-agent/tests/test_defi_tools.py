"""Unit and integration tests for DeFi loan and repayment tools."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from stellar_sdk import Keypair

from talos_agent.api_client import TalosAPIClient
from talos_agent.config import Settings
from talos_agent.db import LocalDB
from talos_agent.tools import defi
from talos_agent.tools.defi import get_active_loans, repay_loan, request_defi_loan

VALID_PUBLIC_KEY = Keypair.random().public_key
VALID_SECRET_KEY = Keypair.random().secret


@pytest.fixture
def in_memory_db() -> LocalDB:
    """In-memory SQLite LocalDB instance."""
    db = LocalDB(Path(":memory:"))
    yield db
    db.close()


@pytest.fixture
def defi_env(in_memory_db: LocalDB, mock_settings: Settings):
    """Configure DeFi tool globals with an in-memory LocalDB and mocked API."""
    mock_settings.approval_threshold = 1000.0
    mock_api = AsyncMock(spec=TalosAPIClient)
    mock_api.create_approval = AsyncMock(return_value={"id": "approval-001"})

    with (
        patch.object(defi, "_db", in_memory_db),
        patch.object(defi, "_api", mock_api),
        patch.object(defi, "_settings", mock_settings),
    ):
        yield {
            "db": in_memory_db,
            "api": mock_api,
            "settings": mock_settings,
        }


class TestRequestDefiLoanInvalidInputs:
    """Parametrised invalid input tests for request_defi_loan."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "invalid_amount",
        [
            0,
            0.0,
            -0.0001,
            -50.0,
            float("nan"),
            float("inf"),
            float("-inf"),
            True,
            False,
            "100",
            None,
        ],
    )
    async def test_rejects_invalid_amount(self, defi_env: dict, invalid_amount):
        db: LocalDB = defi_env["db"]
        api: AsyncMock = defi_env["api"]

        with (
            patch.object(db, "create_loan", wraps=db.create_loan) as spy_create_loan,
            patch.object(
                db, "record_spending", wraps=db.record_spending
            ) as spy_record_spending,
        ):
            result = await request_defi_loan(
                platform="blend",
                amount=invalid_amount,
                duration_days=30,
                repayment_address=VALID_PUBLIC_KEY,
            )

        assert "error" in result
        assert "status" not in result
        spy_create_loan.assert_not_called()
        spy_record_spending.assert_not_called()
        api.create_approval.assert_not_called()
        assert db.get_active_loans() == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "invalid_duration",
        [
            0,
            -1,
            -365,
            366,
            1000,
            30.5,
            float("nan"),
            float("inf"),
            True,
            False,
            "30",
            None,
        ],
    )
    async def test_rejects_invalid_duration_days(
        self, defi_env: dict, invalid_duration
    ):
        db: LocalDB = defi_env["db"]
        api: AsyncMock = defi_env["api"]

        with (
            patch.object(db, "create_loan", wraps=db.create_loan) as spy_create_loan,
            patch.object(
                db, "record_spending", wraps=db.record_spending
            ) as spy_record_spending,
        ):
            result = await request_defi_loan(
                platform="blend",
                amount=100.0,
                duration_days=invalid_duration,
                repayment_address=VALID_PUBLIC_KEY,
            )

        assert "error" in result
        assert "status" not in result
        spy_create_loan.assert_not_called()
        spy_record_spending.assert_not_called()
        api.create_approval.assert_not_called()
        assert db.get_active_loans() == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "invalid_address",
        [
            "",
            "   ",
            "not-a-stellar-key",
            "G" + "A" * 55,  # wrong CRC16 checksum
            "G" + "A" * 54,  # too short
            "G" + "A" * 56,  # too long
            VALID_SECRET_KEY,  # Ed25519 secret seed, not public key
            f" {VALID_PUBLIC_KEY} ",
            12345,
        ],
    )
    async def test_rejects_invalid_repayment_address(
        self, defi_env: dict, invalid_address
    ):
        db: LocalDB = defi_env["db"]
        api: AsyncMock = defi_env["api"]

        with (
            patch.object(db, "create_loan", wraps=db.create_loan) as spy_create_loan,
            patch.object(
                db, "record_spending", wraps=db.record_spending
            ) as spy_record_spending,
        ):
            result = await request_defi_loan(
                platform="blend",
                amount=100.0,
                duration_days=30,
                repayment_address=invalid_address,
            )

        assert "error" in result
        assert "status" not in result
        spy_create_loan.assert_not_called()
        spy_record_spending.assert_not_called()
        api.create_approval.assert_not_called()
        assert db.get_active_loans() == []


class TestRepayLoanInvalidInputs:
    """Parametrised invalid input tests for repay_loan."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "invalid_amount",
        [
            -0.01,
            -1.0,
            -100.0,
            0,
            0.0,
            float("nan"),
            float("inf"),
            float("-inf"),
            True,
            False,
            "25",
        ],
    )
    async def test_rejects_invalid_repayment_amount_without_touching_db(
        self, defi_env: dict, invalid_amount
    ):
        db: LocalDB = defi_env["db"]
        api: AsyncMock = defi_env["api"]

        loan_id = db.create_loan(
            platform="blend",
            amount=100.0,
            collateral_asset="USDC",
            loan_asset="USDC",
            duration_days=30,
            purpose="liquidity",
            repayment_address=VALID_PUBLIC_KEY,
        )

        with (
            patch.object(
                db, "get_loan_by_id", wraps=db.get_loan_by_id
            ) as spy_get_loan,
            patch.object(
                db, "record_repayment", wraps=db.record_repayment
            ) as spy_record_repayment,
        ):
            result = await repay_loan(loan_id=loan_id, amount=invalid_amount)

        assert "error" in result
        assert "status" not in result
        spy_get_loan.assert_not_called()
        spy_record_repayment.assert_not_called()
        api.create_approval.assert_not_called()

        loan = db.get_loan_by_id(loan_id)
        assert loan is not None
        assert loan["outstanding_amount"] == pytest.approx(100.0)
        assert loan["status"] == "active"


class TestDefiToolsHappyPath:
    """Happy path tests using an in-memory LocalDB."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("duration_days", [1, 30, 365])
    async def test_request_and_repay_loan_lifecycle(
        self, defi_env: dict, duration_days: int
    ):
        db: LocalDB = defi_env["db"]

        request_result = await request_defi_loan(
            platform="blend",
            amount=200.0,
            collateral_asset="XLM",
            loan_asset="USDC",
            duration_days=duration_days,
            purpose="Working capital",
            repayment_address=VALID_PUBLIC_KEY,
        )

        assert request_result["status"] == "requested"
        loan_id = request_result["loan_id"]
        assert request_result["amount"] == pytest.approx(200.0)
        assert request_result["duration_days"] == duration_days
        assert request_result["repayment_address"] == VALID_PUBLIC_KEY
        assert db.get_spending_today() == pytest.approx(200.0)

        active = await get_active_loans()
        assert active["count"] == 1
        assert active["loans"][0]["id"] == loan_id
        assert active["loans"][0]["outstanding_amount"] == pytest.approx(200.0)

        # Partial repayment
        partial = await repay_loan(loan_id=loan_id, amount=75.0)
        assert partial == {
            "status": "repayment_recorded",
            "loan_id": loan_id,
            "amount": pytest.approx(75.0),
            "remaining": pytest.approx(125.0),
        }
        loan_after_partial = db.get_loan_by_id(loan_id)
        assert loan_after_partial is not None
        assert loan_after_partial["status"] == "active"
        assert loan_after_partial["outstanding_amount"] == pytest.approx(125.0)

        # Full remaining repayment (amount=None)
        full = await repay_loan(loan_id=loan_id)
        assert full == {
            "status": "repayment_recorded",
            "loan_id": loan_id,
            "amount": pytest.approx(125.0),
            "remaining": pytest.approx(0.0),
        }
        loan_after_full = db.get_loan_by_id(loan_id)
        assert loan_after_full is not None
        assert loan_after_full["status"] == "repaid"
        assert loan_after_full["outstanding_amount"] == pytest.approx(0.0)

        active_after = await get_active_loans()
        assert active_after["count"] == 0

    @pytest.mark.asyncio
    async def test_request_loan_allows_none_repayment_address(self, defi_env: dict):
        result = await request_defi_loan(
            platform="aave",
            amount=50.0,
            duration_days=14,
            repayment_address=None,
        )
        assert result["status"] == "requested"
        assert result["repayment_address"] is None

    @pytest.mark.asyncio
    async def test_above_threshold_requests_approval(self, defi_env: dict):
        defi_env["settings"].approval_threshold = 100.0
        api: AsyncMock = defi_env["api"]
        db: LocalDB = defi_env["db"]

        loan_res = await request_defi_loan(
            platform="blend",
            amount=250.0,
            duration_days=30,
            repayment_address=VALID_PUBLIC_KEY,
        )
        assert loan_res["status"] == "approval_requested"
        assert loan_res["approval_id"] == "approval-001"
        assert db.get_active_loans() == []
        api.create_approval.assert_awaited_once()
