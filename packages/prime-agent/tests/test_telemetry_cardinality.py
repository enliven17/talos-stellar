"""Tests for telemetry label cardinality limiting (issue #555).

Covers:
  - _normalize_task / _normalize_tool / _normalize_model / _normalize_outcome
  - _normalize_status_code / _normalize_retry_count
  - record_* functions use normalised labels (spy via monkeypatching)
  - Boundary inputs: empty strings, None-like strings, very long values,
    known-good values, unknown values
  - Regression: existing known values still pass through unchanged
"""
from __future__ import annotations

import pytest

from talos_agent.metrics import (
    _ALLOWED_MODELS,
    _ALLOWED_OUTCOMES,
    _ALLOWED_RETRY_COUNTS,
    _ALLOWED_STATUS_CODES,
    _ALLOWED_TASKS,
    _ALLOWED_TOOLS,
    _normalize_model,
    _normalize_outcome,
    _normalize_retry_count,
    _normalize_status_code,
    _normalize_task,
    _normalize_tool,
    record_cycle,
    record_http_call,
    record_llm_call,
    record_tool_call,
)

# ── _normalize_task ───────────────────────────────────────────────────────────


class TestNormalizeTask:
    @pytest.mark.parametrize("task", sorted(_ALLOWED_TASKS))
    def test_known_tasks_pass_through(self, task: str) -> None:
        assert _normalize_task(task) == task

    def test_unknown_task_returns_other(self) -> None:
        assert _normalize_task("some_new_task_never_registered") == "other"

    def test_empty_string_returns_other(self) -> None:
        assert _normalize_task("") == "other"

    def test_very_long_string_returns_other(self) -> None:
        assert _normalize_task("x" * 500) == "other"

    def test_uppercase_variant_returns_other(self) -> None:
        # task names are case-sensitive; upper-cased variants are unknown
        assert _normalize_task("AGENT_CYCLE") == "other"

    def test_sentinel_is_in_allowlist(self) -> None:
        # Sentinel must not cause infinite recursion by failing its own check
        assert _normalize_task("other") == "other"


# ── _normalize_tool ───────────────────────────────────────────────────────────


class TestNormalizeTool:
    @pytest.mark.parametrize("tool", sorted(_ALLOWED_TOOLS))
    def test_known_tools_pass_through(self, tool: str) -> None:
        assert _normalize_tool(tool) == tool

    def test_unknown_tool_returns_other_tool(self) -> None:
        assert _normalize_tool("totally_unknown_tool_xyz") == "other_tool"

    def test_empty_string_returns_other_tool(self) -> None:
        assert _normalize_tool("") == "other_tool"

    def test_dynamic_job_id_returns_other_tool(self) -> None:
        # Job IDs must never become label values
        assert _normalize_tool("job_abc123def456") == "other_tool"

    def test_wallet_address_returns_other_tool(self) -> None:
        assert _normalize_tool("GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37") == "other_tool"

    def test_sentinel_is_in_allowlist(self) -> None:
        assert _normalize_tool("other_tool") == "other_tool"


# ── _normalize_model ──────────────────────────────────────────────────────────


class TestNormalizeModel:
    @pytest.mark.parametrize("model", sorted(_ALLOWED_MODELS))
    def test_known_models_pass_through(self, model: str) -> None:
        assert _normalize_model(model) == model

    def test_unknown_model_returns_other_model(self) -> None:
        assert _normalize_model("gpt-99-turbo-mega") == "other_model"

    def test_empty_string_returns_other_model(self) -> None:
        assert _normalize_model("") == "other_model"

    def test_partial_model_name_returns_other_model(self) -> None:
        # Partial matches must not pass through
        assert _normalize_model("llama3") == "other_model"

    def test_sentinel_is_in_allowlist(self) -> None:
        assert _normalize_model("other_model") == "other_model"


# ── _normalize_outcome ────────────────────────────────────────────────────────


class TestNormalizeOutcome:
    @pytest.mark.parametrize("outcome", sorted(_ALLOWED_OUTCOMES))
    def test_known_outcomes_pass_through(self, outcome: str) -> None:
        assert _normalize_outcome(outcome) == outcome

    def test_unknown_outcome_returns_other(self) -> None:
        assert _normalize_outcome("partial_failure") == "other"

    def test_empty_string_returns_other(self) -> None:
        assert _normalize_outcome("") == "other"

    def test_free_text_error_message_returns_other(self) -> None:
        assert _normalize_outcome("HTTP 503 Service Unavailable") == "other"

    def test_sentinel_is_in_allowlist(self) -> None:
        assert _normalize_outcome("other") == "other"


# ── _normalize_status_code ────────────────────────────────────────────────────


class TestNormalizeStatusCode:
    @pytest.mark.parametrize("code", sorted(_ALLOWED_STATUS_CODES))
    def test_known_status_codes_pass_through(self, code: str) -> None:
        assert _normalize_status_code(code) == code

    def test_unknown_status_code_returns_other(self) -> None:
        assert _normalize_status_code("999") == "other"

    def test_zero_network_error_returns_other(self) -> None:
        # Status 0 (network error) is not in the allowlist → sentinel
        assert _normalize_status_code("0") == "other"

    def test_empty_string_returns_other(self) -> None:
        assert _normalize_status_code("") == "other"

    def test_non_numeric_string_returns_other(self) -> None:
        assert _normalize_status_code("bad-status") == "other"

    def test_dynamic_code_with_detail_returns_other(self) -> None:
        # Status with message appended must be rejected
        assert _normalize_status_code("500 Internal Server Error") == "other"

    def test_sentinel_is_in_allowlist(self) -> None:
        assert _normalize_status_code("other") == "other"

    def test_common_2xx_codes_pass_through(self) -> None:
        for code in ("200", "201", "204"):
            assert _normalize_status_code(code) == code

    def test_common_4xx_codes_pass_through(self) -> None:
        for code in ("400", "401", "403", "404", "429"):
            assert _normalize_status_code(code) == code

    def test_common_5xx_codes_pass_through(self) -> None:
        for code in ("500", "502", "503", "504"):
            assert _normalize_status_code(code) == code


# ── _normalize_retry_count ────────────────────────────────────────────────────


class TestNormalizeRetryCount:
    @pytest.mark.parametrize("count", ["0", "1", "2", "3", "4", "5", "5+"])
    def test_known_retry_counts_pass_through(self, count: str) -> None:
        assert _normalize_retry_count(count) == count

    def test_six_collapses_to_five_plus(self) -> None:
        assert _normalize_retry_count("6") == "5+"

    def test_large_number_collapses_to_five_plus(self) -> None:
        assert _normalize_retry_count("100") == "5+"

    def test_negative_returns_other(self) -> None:
        assert _normalize_retry_count("-1") == "other"

    def test_empty_string_returns_other(self) -> None:
        assert _normalize_retry_count("") == "other"

    def test_non_numeric_returns_other(self) -> None:
        assert _normalize_retry_count("many") == "other"

    def test_float_string_returns_other(self) -> None:
        # "2.5" is not an integer string
        assert _normalize_retry_count("2.5") == "other"


# ── record_* integration: normalisation is applied ───────────────────────────
#
# The record_* functions are no-ops when metrics_enabled() is False (default
# in CI), but the normalisation happens before the guard.  We verify this by
# monkey-patching _record_histogram / _record_counter to capture the actual
# attributes passed to the instrument layer.


class TestRecordFunctionsApplyNormalisation:
    """Verify that record_* normalises labels even when metrics are disabled."""

    def _capture_attrs(self, monkeypatch):
        """Return lists that accumulate (name, attrs) tuples from the internals."""
        histogram_calls: list[tuple[str, dict]] = []
        counter_calls: list[tuple[str, dict]] = []

        import talos_agent.metrics as m

        def fake_histogram(name: str, value: float, attributes) -> None:
            histogram_calls.append((name, dict(attributes)))

        def fake_counter(name: str, attributes, value: int = 1) -> None:
            counter_calls.append((name, dict(attributes)))

        monkeypatch.setattr(m, "_record_histogram", fake_histogram)
        monkeypatch.setattr(m, "_record_counter", fake_counter)
        return histogram_calls, counter_calls

    def test_record_cycle_normalises_unknown_task(self, monkeypatch) -> None:
        h, c = self._capture_attrs(monkeypatch)
        record_cycle("unknown_future_task", "success", 1.0)
        assert h[0][1]["agent.task"] == "other"
        assert c[0][1]["agent.task"] == "other"

    def test_record_cycle_normalises_unknown_outcome(self, monkeypatch) -> None:
        h, c = self._capture_attrs(monkeypatch)
        record_cycle("agent_cycle", "partial_failure", 0.5)
        assert h[0][1]["outcome"] == "other"
        assert c[0][1]["outcome"] == "other"

    def test_record_cycle_passes_known_values(self, monkeypatch) -> None:
        h, _c = self._capture_attrs(monkeypatch)
        record_cycle("polling", "error", 0.1)
        assert h[0][1]["agent.task"] == "polling"
        assert h[0][1]["outcome"] == "error"

    def test_record_tool_call_normalises_dynamic_tool_name(self, monkeypatch) -> None:
        h, c = self._capture_attrs(monkeypatch)
        record_tool_call("job_abc123_dynamic", "error", 0.2)
        assert h[0][1]["tool.name"] == "other_tool"
        assert c[0][1]["tool.name"] == "other_tool"

    def test_record_tool_call_passes_known_tool(self, monkeypatch) -> None:
        h, _c = self._capture_attrs(monkeypatch)
        record_tool_call("post_content", "success", 0.3)
        assert h[0][1]["tool.name"] == "post_content"

    def test_record_llm_call_normalises_unknown_model(self, monkeypatch) -> None:
        h, _ = self._capture_attrs(monkeypatch)
        record_llm_call("openai-gpt-5-hypothetical", "success", 1.5)
        assert h[0][1]["llm.model"] == "other_model"

    def test_record_llm_call_passes_known_model(self, monkeypatch) -> None:
        h, _ = self._capture_attrs(monkeypatch)
        record_llm_call("llama3-8b-8192", "success", 0.8)
        assert h[0][1]["llm.model"] == "llama3-8b-8192"

    def test_record_http_call_normalises_unknown_status(self, monkeypatch) -> None:
        h, _ = self._capture_attrs(monkeypatch)
        record_http_call(999, 0, 0.05)
        assert h[0][1]["http.response.status_code"] == "other"

    def test_record_http_call_normalises_high_retry_count(self, monkeypatch) -> None:
        h, _ = self._capture_attrs(monkeypatch)
        record_http_call(200, 10, 0.1)
        assert h[0][1]["http.retry.count"] == "5+"

    def test_record_http_call_passes_known_status_and_retry(self, monkeypatch) -> None:
        h, _ = self._capture_attrs(monkeypatch)
        record_http_call(429, 3, 0.2)
        assert h[0][1]["http.response.status_code"] == "429"
        assert h[0][1]["http.retry.count"] == "3"

    def test_record_http_call_status_zero_returns_other(self, monkeypatch) -> None:
        """Status 0 (network error) must not leak as a label."""
        h, _ = self._capture_attrs(monkeypatch)
        record_http_call(0, 0, 0.01)
        assert h[0][1]["http.response.status_code"] == "other"


# ── Allowlist completeness / consistency checks ───────────────────────────────


class TestAllowlistConsistency:
    """Static checks that ensure the allowlists are self-consistent."""

    def test_task_allowlist_contains_sentinel(self) -> None:
        assert "other" in _ALLOWED_TASKS

    def test_tool_allowlist_contains_sentinel(self) -> None:
        assert "other_tool" in _ALLOWED_TOOLS

    def test_model_allowlist_contains_sentinel(self) -> None:
        assert "other_model" in _ALLOWED_MODELS

    def test_outcome_allowlist_contains_sentinel(self) -> None:
        assert "other" in _ALLOWED_OUTCOMES

    def test_status_code_allowlist_contains_sentinel(self) -> None:
        assert "other" in _ALLOWED_STATUS_CODES

    def test_retry_count_allowlist_contains_five_plus(self) -> None:
        assert "5+" in _ALLOWED_RETRY_COUNTS

    def test_all_allowlists_are_frozensets(self) -> None:
        for name, obj in [
            ("_ALLOWED_TASKS", _ALLOWED_TASKS),
            ("_ALLOWED_TOOLS", _ALLOWED_TOOLS),
            ("_ALLOWED_MODELS", _ALLOWED_MODELS),
            ("_ALLOWED_OUTCOMES", _ALLOWED_OUTCOMES),
            ("_ALLOWED_STATUS_CODES", _ALLOWED_STATUS_CODES),
            ("_ALLOWED_RETRY_COUNTS", _ALLOWED_RETRY_COUNTS),
        ]:
            assert isinstance(obj, frozenset), f"{name} should be a frozenset"

    def test_task_allowlist_covers_all_scheduler_tasks(self) -> None:
        """All tasks emitted by the scheduler must be in the allowlist."""
        expected = {
            "agent_cycle",
            "polling",
            "heartbeat",
            "job_heartbeat",
            "activity_flush",
            "learning_cycle",
            "dividend_distribution",
            "loan_repayment",
        }
        assert expected.issubset(_ALLOWED_TASKS)

    def test_retry_count_allowlist_covers_zero_through_five(self) -> None:
        for i in range(6):
            assert str(i) in _ALLOWED_RETRY_COUNTS
