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


def test_scheduler_concurrency_setting_is_bounded(monkeypatch):
    from talos_agent.config import Settings

    monkeypatch.delenv("SCHEDULER_MAX_CONCURRENT_TASKS", raising=False)
    assert Settings(_env_file=None).scheduler_max_concurrent_tasks == 4

    for value in (1, 16):
        monkeypatch.setenv("SCHEDULER_MAX_CONCURRENT_TASKS", str(value))
        assert Settings(_env_file=None).scheduler_max_concurrent_tasks == value

    for value in (0, 17):
        monkeypatch.setenv("SCHEDULER_MAX_CONCURRENT_TASKS", str(value))
        try:
            Settings(_env_file=None)
        except ValidationError:
            pass
        else:  # pragma: no cover
            raise AssertionError(f"expected concurrency limit {value} to be rejected")
