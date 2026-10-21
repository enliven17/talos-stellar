"""Pure-async helper functions for individual scheduler tasks.

These are extracted from the monolithic ``run()`` loop so they can be tested
in isolation without spinning up a browser, Stellar wallet, or API client.
"""

from __future__ import annotations

import logging

from talos_agent.payments.stellar_retry import (
    classify_stellar_failure,
    classify_stellar_result,
)

logger = logging.getLogger(__name__)


def _is_stellar_public_key(value: object) -> bool:
    return isinstance(value, str) and value.startswith("G") and len(value) == 56


async def run_dividend_distribution(
    *,
    talos_id: str,
    talos_config: dict,
    settings,
    stellar,
    api,
    db,
) -> str:
    """Core dividend distribution logic extracted for testability.

    Returns a status string: ``'no_wallet'``, ``'missing_creator'``,
    ``'below_threshold'``, ``'preview_failed'``, ``'distribution_failed'``,
    ``'success'``, or ``'balance_error'``.
    """
    stellar_account_id = talos_config.get("walletPublicKey", "")
    if not stellar_account_id:
        return "no_wallet"

    balance_result = await stellar.get_token_balance(stellar_account_id, "USDC")

    if "error" in balance_result:
        db.update_schedule("dividend_distribution")
        return "balance_error"

    usdc_balance = balance_result.get("balance", 0)

    if usdc_balance < float(settings.dividend_usdc_threshold):
        return "below_threshold"

    preview = await api.get_distribution_preview(talos_id)
    if not preview or "error" in preview:
        return "preview_failed"

    creator_public_key = talos_config.get("creatorPublicKey", "")
    if not creator_public_key:
        return "missing_creator"

    result = await api.distribute_dividends(
        talos_id,
        requester_public_key=creator_public_key,
    )

    if not result or "error" in result:
        return "distribution_failed"

    db.update_schedule("dividend_distribution")
    return "success"


async def run_loan_repayment(
    *,
    settings,
    stellar_kit,
    api,
    db,
    days: int = 7,
) -> dict:
    """Monitor and auto-repay due loans. Returns a structured result summary."""
    loans_due = db.get_loans_due_soon(days=days)
    result = {
        "status": "no_loans" if not loans_due else "processed",
        "processed": 0,
        "repaid": 0,
        "warnings": 0,
        "errors": 0,
        # Bounded, privacy-safe failure classification counts (see
        # talos_agent.payments.stellar_retry) so operators can tell a
        # transient outage from a terminal input error at a glance.
        "failure_classes": {},
    }

    if not loans_due:
        db.update_schedule("loan_repayment")
        return result

    if not settings.auto_repay_loans:
        for loan in loans_due:
            db.add_activity(
                "loan_warning",
                f"Loan {loan['id']} due but auto-repay disabled. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                "defi",
            )
            result["warnings"] += 1
        db.update_schedule("loan_repayment")
        return result

    await stellar_kit.initialize()
    balance_result = await stellar_kit.get_balance()
    if "error" in balance_result:
        for loan in loans_due:
            db.add_activity(
                "loan_warning",
                f"Loan {loan['id']} due but balance query failed. Outstanding: {loan['outstanding_amount']} {loan['loan_asset']}",
                "defi",
            )
            result["warnings"] += 1
        result["status"] = "balance_error"
        db.update_schedule("loan_repayment")
        return result

    available_balance = float(balance_result.get("balance_xlm", 0))

    for loan in loans_due:
        result["processed"] += 1
        loan_id = loan["id"]
        outstanding = float(loan["outstanding_amount"])
        loan_asset = loan["loan_asset"]
        repayment_address = loan.get("repayment_address")

        if loan_asset != "XLM":
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but auto-repay only supports XLM (asset: {loan_asset})",
                "defi",
            )
            result["warnings"] += 1
            continue

        if not _is_stellar_public_key(repayment_address):
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but repayment destination is missing or invalid",
                "defi",
            )
            result["warnings"] += 1
            continue

        repay_amount = min(outstanding, available_balance)
        if repay_amount <= 0:
            db.add_activity(
                "loan_warning",
                f"Loan {loan_id} due but insufficient funds. Outstanding: {outstanding}, Available: {available_balance}",
                "defi",
            )
            result["warnings"] += 1
            continue

        transfer_result = await api.request_transfer(
            to_account=repayment_address,
            amount=repay_amount,
            currency="XLM",
        )

        if not transfer_result or "error" in transfer_result:
            db.add_activity(
                "loan_error",
                f"Auto-repay failed for loan {loan_id}: {transfer_result.get('error', 'Unknown error') if transfer_result else 'No result'}",
                "defi",
            )
            result["errors"] += 1
            # Classify so the operator-facing summary distinguishes a
            # transient outage (retryable) from a terminal failure.
            failure = classify_stellar_result(transfer_result) or classify_stellar_failure()
            classes = result["failure_classes"]
            classes[failure.classification.value] = (
                classes.get(failure.classification.value, 0) + 1
            )
            continue

        db.record_repayment(loan_id, repay_amount, tx_hash=transfer_result.get("tx_hash"))
        db.add_activity(
            "loan_repayment",
            f"Auto-repaid loan {loan_id}: {repay_amount} XLM. TX: {transfer_result.get('tx_hash', 'pending')}",
            "defi",
        )
        available_balance -= repay_amount
        result["repaid"] += 1

    db.update_schedule("loan_repayment")
    return result
