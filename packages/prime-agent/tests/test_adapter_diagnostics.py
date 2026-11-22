"""Tests for case-preserving remote account and provider identifiers in adapter diagnostics (#1466)."""

from __future__ import annotations

from talos_agent.adapters.diagnostics import (
    MAX_ACCOUNT_LENGTH,
    MAX_PROVIDER_LENGTH,
    safe_adapter_diagnostic_fields,
)


class TestAdapterDiagnosticsCasePreservation:
    """Ensure remote account identifiers and provider IDs remain case-preserving and bounded."""

    def test_provider_and_remote_account_identifiers_preserve_case(self) -> None:
        """Provider and remote account identifiers preserve case and are not lowercased."""
        fields = safe_adapter_diagnostic_fields(
            provider="StellarHorizon",
            remote_account="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
            operation="post",
            outcome="succeeded",
        )
        assert fields["adapter"] == "StellarHorizon"
        assert fields["account"] == "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        assert fields["operation"] == "post"
        assert fields["outcome"] == "succeeded"

    def test_account_alias_field_preserves_case(self) -> None:
        """Both 'account' and 'account_id' aliases preserve case."""
        fields1 = safe_adapter_diagnostic_fields(
            adapter="DiscordBot",
            account="UserAccount-1234",
        )
        assert fields1["adapter"] == "DiscordBot"
        assert fields1["account"] == "UserAccount-1234"

        fields2 = safe_adapter_diagnostic_fields(
            adapter="TelegramChannel",
            account_id="ChatAccount-XYZ",
        )
        assert fields2["adapter"] == "TelegramChannel"
        assert fields2["account"] == "ChatAccount-XYZ"

    def test_overlong_remote_account_identifier_normalized_to_unknown(self) -> None:
        """Remote account identifier exceeding MAX_ACCOUNT_LENGTH becomes 'unknown'."""
        overlong_account = "G" + "A" * (MAX_ACCOUNT_LENGTH + 10)
        fields = safe_adapter_diagnostic_fields(
            provider="ProviderOne",
            remote_account=overlong_account,
        )
        assert fields["adapter"] == "ProviderOne"
        assert fields["account"] == "unknown"

    def test_overlong_provider_identifier_normalized_to_unknown(self) -> None:
        """Provider identifier exceeding MAX_PROVIDER_LENGTH becomes 'unknown'."""
        overlong_provider = "Provider" + "X" * (MAX_PROVIDER_LENGTH + 10)
        fields = safe_adapter_diagnostic_fields(
            provider=overlong_provider,
            remote_account="ValidAccount",
        )
        assert fields["adapter"] == "unknown"
        assert fields["account"] == "ValidAccount"

    def test_unsafe_remote_account_characters_normalized_to_unknown(self) -> None:
        """Control characters, spaces, or invalid characters become 'unknown'."""
        fields = safe_adapter_diagnostic_fields(
            provider="ValidProvider",
            remote_account="Account\nWithNewline",
        )
        assert fields["account"] == "unknown"

        fields_slash = safe_adapter_diagnostic_fields(
            provider="ValidProvider",
            remote_account="Account/WithSlash",
        )
        assert fields_slash["account"] == "unknown"

        fields_space = safe_adapter_diagnostic_fields(
            provider="ValidProvider",
            remote_account="Account With Space",
        )
        assert fields_space["account"] == "unknown"

    def test_sensitive_account_keys_redacted(self) -> None:
        """Nested sensitive values or tokens in account fields are properly sanitized."""
        fields = safe_adapter_diagnostic_fields(
            provider="ValidProvider",
            remote_account={"token": "secret_token_123"},
        )
        assert fields["account"] == "unknown"

    def test_boundary_max_length_remote_account_preserved(self) -> None:
        """Account identifier exactly at MAX_ACCOUNT_LENGTH is preserved with full case."""
        exact_account = "A" + "B" * (MAX_ACCOUNT_LENGTH - 1)
        assert len(exact_account) == MAX_ACCOUNT_LENGTH
        fields = safe_adapter_diagnostic_fields(
            provider="ValidProvider",
            remote_account=exact_account,
        )
        assert fields["account"] == exact_account

    def test_backward_compatible_adapter_and_provider_keys(self) -> None:
        """Existing safe diagnostic fields remain intact and fully compatible."""
        fields = safe_adapter_diagnostic_fields(
            adapter="TelegramAdapter",
            operation="post",
            operation_id="Op-12345",
            outcome="succeeded",
            error_type="CustomError",
            capability="network",
            target="api.telegram.org",
            resource="request",
            duration_ms=45.67,
        )
        assert fields == {
            "adapter": "TelegramAdapter",
            "operation": "post",
            "operation_id": "Op-12345",
            "outcome": "succeeded",
            "error_type": "CustomError",
            "capability": "network",
            "target": "api.telegram.org",
            "resource": "request",
            "duration_ms": 45.67,
        }
