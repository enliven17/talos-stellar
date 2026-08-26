"""Regression tests for the agent log-safety policy."""

from __future__ import annotations

import json

from talos_agent.redaction import redact, redact_text


def test_sensitive_fixture_is_redacted_before_serialization() -> None:
    stellar_secret = "S" + "A" * 55
    fixture = {
        "secretKey": stellar_secret,
        "encryptedKeyMaterial": "encrypted-key-material-fixture",
        "bearerToken": "Bearer bearer-token-fixture",
        "authorization": "Bearer authorization-fixture",
        "paymentHeader": "Bearer payment-header-fixture",
        "paymentProof": "full-x402-payment-proof-fixture",
        "paymentSig": "payment-signature-fixture",
        "signedXdr": "signed-xdr-fixture",
        "apiKey": "api-key-fixture",
        "password": "password-fixture",
        "webhookUrl": "https://discord.example/webhook-fixture",
        "token_id": "safe-token-id",
        "cycle_id": "safe-cycle-id",
        "tx_hash": "safe-transaction-hash",
    }

    serialized = json.dumps(redact(fixture))
    for sensitive_value in fixture.values():
        if sensitive_value not in {"safe-token-id", "safe-cycle-id", "safe-transaction-hash"}:
            assert sensitive_value not in serialized
    assert "safe-token-id" in serialized
    assert "safe-cycle-id" in serialized
    assert "safe-transaction-hash" in serialized


def test_exception_text_is_redacted_before_retry_or_error_logging() -> None:
    stellar_secret = "S" + "B" * 55
    error = RuntimeError(
        f"paymentProof=proof-fixture secretKey={stellar_secret} "
        "Authorization=Bearer exception-token-fixture"
    )

    safe_message = redact_text(str(error))

    assert "proof-fixture" not in safe_message
    assert stellar_secret not in safe_message
    assert "exception-token-fixture" not in safe_message
    assert "RuntimeError" not in safe_message