"""Configuration failures must remain useful without leaking credentials."""

from pydantic import BaseModel, ValidationError

from talos_agent.config import safe_config_error


class CredentialSettings(BaseModel):
    api_key: int


def test_safe_config_error_redacts_secret_input_value():
    try:
        CredentialSettings(api_key="super-secret-value")
    except ValidationError as exc:
        message = safe_config_error(exc)
    else:  # pragma: no cover
        raise AssertionError("expected validation error")

    assert "super-secret-value" not in message
    assert "[REDACTED]" in message
    assert "api_key" in message


def test_safe_config_error_preserves_non_secret_context_without_value():
    try:
        CredentialSettings(api_key="not-a-number")
    except ValidationError as exc:
        message = safe_config_error(exc)
    else:  # pragma: no cover
        raise AssertionError("expected validation error")

    assert "api_key" in message
    assert "not-a-number" not in message
