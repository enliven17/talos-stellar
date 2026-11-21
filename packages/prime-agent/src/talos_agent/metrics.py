"""OpenTelemetry metrics for the prime-agent — a small, bounded instrument set.

Disabled by default (``OTEL_METRICS_ENABLED`` unset/false, and gated behind
``OTEL_ENABLED`` overall — see ``tracing.py``/``docs/TRACING.md``). All
attribute values used here are fixed, low-cardinality dimensions (task
names, tool names, HTTP status codes, model names) — never account IDs, job
IDs, or free text — to keep cardinality bounded on the receiving backend.

Cardinality controls
--------------------
Each attribute key has a statically defined allowlist.  Any value that is
not in the allowlist is replaced with the sentinel ``"other"`` before the
data point is emitted.  This prevents unbounded cardinality growth on metric
backends caused by free-text values (dynamic job IDs, long error messages,
wallet addresses, etc.) or newly deployed task/tool names that have not been
registered yet.

The allowlists are intentionally conservative:

* ``agent.task`` — the eight scheduled task names known at compile time.
* ``tool.name``  — the primary tool categories; unknown tools collapse to
  ``"other_tool"``.
* ``llm.model``  — known Groq model identifiers; unknown models collapse to
  ``"other_model"``.
* ``outcome``    — ``"success"`` or ``"error"``.
* ``http.response.status_code`` — 1xx–5xx class strings; unknown codes
  collapse to ``"other"``.
* ``http.retry.count`` — ``"0"``–``"5"``; anything higher collapses to
  ``"5+"``.

To add a new known value: extend the relevant ``_ALLOWED_*`` frozenset and
add a test in ``tests/test_telemetry_cardinality.py``.
"""
from __future__ import annotations

import os
from typing import Mapping

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource

from talos_agent.tracing import SERVICE_NAME_DEFAULT, is_enabled

_METER_NAME = "talos_agent"
_EXPORT_INTERVAL_MILLIS = 15000

_configured = False
_instruments: dict[str, object] = {}
_provider: MeterProvider | None = None


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def metrics_enabled() -> bool:
    return is_enabled() and _env_bool("OTEL_METRICS_ENABLED", False)


def configure_metrics() -> None:
    """Initialize the global MeterProvider exactly once per process.

    No-op unless metrics are explicitly enabled (see ``metrics_enabled``).
    """
    global _configured
    if _configured:
        return
    _configured = True

    if not metrics_enabled():
        return

    service_name = os.getenv("OTEL_SERVICE_NAME", SERVICE_NAME_DEFAULT)
    resource = Resource.create({"service.name": service_name})

    exporter_kind = os.getenv("OTEL_TRACES_EXPORTER", "otlp").strip().lower()
    if exporter_kind == "console":
        from opentelemetry.sdk.metrics.export import ConsoleMetricExporter

        exporter = ConsoleMetricExporter()
    else:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )

        exporter = OTLPMetricExporter()

    reader = PeriodicExportingMetricReader(
        exporter, export_interval_millis=_EXPORT_INTERVAL_MILLIS
    )
    _provider = MeterProvider(resource=resource, metric_readers=[reader])
    metrics.set_meter_provider(_provider)
    _build_instruments()


def force_flush_metrics() -> None:
    if _provider is not None:
        try:
            _provider.force_flush()
        except Exception:
            pass


def shutdown_metrics() -> None:
    if _provider is None:
        return
    try:
        _provider.force_flush()
    except Exception:
        pass
    try:
        _provider.shutdown()
    except Exception:
        pass


def _build_instruments() -> None:
    meter = metrics.get_meter(_METER_NAME)
    _instruments["cycle_duration"] = meter.create_histogram(
        "talos_agent_cycle_duration_seconds",
        unit="s",
        description="Duration of a scheduled agent task run (cycle, poll, heartbeat, ...).",
    )
    _instruments["cycle_total"] = meter.create_counter(
        "talos_agent_cycle_total",
        description="Count of scheduled agent task runs by outcome.",
    )
    _instruments["tool_call_duration"] = meter.create_histogram(
        "talos_agent_tool_call_duration_seconds",
        unit="s",
        description="Duration of a single tool invocation.",
    )
    _instruments["tool_call_errors"] = meter.create_counter(
        "talos_agent_tool_call_errors_total",
        description="Count of failed tool invocations.",
    )
    _instruments["llm_call_duration"] = meter.create_histogram(
        "talos_agent_llm_call_duration_seconds",
        unit="s",
        description="Duration of an LLM chat-completion call.",
    )
    _instruments["http_client_duration"] = meter.create_histogram(
        "talos_agent_http_client_duration_seconds",
        unit="s",
        description="Duration of a logical (post-retry) HTTP call to the Talos Web API.",
    )


# ── Cardinality control ───────────────────────────────────────────────────────
#
# Each dimension below has a *closed* allowlist.  Values outside the list are
# replaced by a static sentinel so Prometheus/OTEL backends never accumulate
# an unbounded time-series per unique value.
#
# Rules:
#   1. Sentinels must themselves be in the allowlist so they pass the check
#      without recursion.
#   2. Every allowlist is a ``frozenset`` for O(1) membership tests.
#   3. The normalisation functions are pure and never raise.

#: Known scheduled-task names emitted as ``agent.task``.
_ALLOWED_TASKS: frozenset[str] = frozenset(
    {
        "agent_cycle",
        "polling",
        "heartbeat",
        "job_heartbeat",
        "activity_flush",
        "learning_cycle",
        "dividend_distribution",
        "loan_repayment",
        # sentinel
        "other",
    }
)

#: Known tool-call names emitted as ``tool.name``.
_ALLOWED_TOOLS: frozenset[str] = frozenset(
    {
        "post_content",
        "research",
        "reply",
        "commerce_buy",
        "commerce_sell",
        "commerce_register",
        "stellar_transfer",
        "stellar_balance",
        "registry_lookup",
        "defi_swap",
        "browser_navigate",
        "browser_extract",
        "planning",
        "learning",
        "a2a_compose",
        "a2a_intent",
        "internal",
        "publishing",
        "permissions",
        # sentinel
        "other_tool",
    }
)

#: Known LLM model identifiers emitted as ``llm.model``.
_ALLOWED_MODELS: frozenset[str] = frozenset(
    {
        "llama3-8b-8192",
        "llama3-70b-8192",
        "llama-3.1-8b-instant",
        "llama-3.1-70b-versatile",
        "llama-3.3-70b-versatile",
        "mixtral-8x7b-32768",
        "gemma2-9b-it",
        "gemma-7b-it",
        # sentinel
        "other_model",
    }
)

#: Allowed outcome values.
_ALLOWED_OUTCOMES: frozenset[str] = frozenset({"success", "error", "other"})

#: HTTP status-code classes (string representation) allowed as
#: ``http.response.status_code``.
_ALLOWED_STATUS_CODES: frozenset[str] = frozenset(
    {
        # 1xx
        "100", "101",
        # 2xx
        "200", "201", "202", "204",
        # 3xx
        "301", "302", "304",
        # 4xx
        "400", "401", "402", "403", "404", "405", "408", "409", "410",
        "422", "429",
        # 5xx
        "500", "502", "503", "504",
        # sentinel (covers 0 / network errors / unknown)
        "other",
    }
)

#: Allowed HTTP retry-count strings (``"0"``–``"5"``; higher collapses to
#: ``"5+"``).
_ALLOWED_RETRY_COUNTS: frozenset[str] = frozenset({"0", "1", "2", "3", "4", "5", "5+"})


def _normalize_task(value: str) -> str:
    """Return *value* if it is a known task name, else ``"other"``."""
    return value if value in _ALLOWED_TASKS else "other"


def _normalize_tool(value: str) -> str:
    """Return *value* if it is a known tool name, else ``"other_tool"``."""
    return value if value in _ALLOWED_TOOLS else "other_tool"


def _normalize_model(value: str) -> str:
    """Return *value* if it is a known model identifier, else ``"other_model"``."""
    return value if value in _ALLOWED_MODELS else "other_model"


def _normalize_outcome(value: str) -> str:
    """Return *value* if it is a known outcome, else ``"other"``."""
    return value if value in _ALLOWED_OUTCOMES else "other"


def _normalize_status_code(value: str) -> str:
    """Return *value* if it is a known HTTP status code string, else ``"other"``."""
    return value if value in _ALLOWED_STATUS_CODES else "other"


def _normalize_retry_count(value: str) -> str:
    """Return *value* if it is in ``0``–``5``, ``"5+"`` for higher counts, else ``"other"``."""
    if value in _ALLOWED_RETRY_COUNTS:
        return value
    try:
        n = int(value)
        if n > 5:
            return "5+"
    except (ValueError, TypeError):
        pass
    return "other"


def _record_histogram(name: str, value: float, attributes: Mapping[str, str]) -> None:
    if not metrics_enabled():
        return
    instrument = _instruments.get(name)
    if instrument is None:
        return
    instrument.record(value, attributes=dict(attributes))


def _record_counter(name: str, attributes: Mapping[str, str], value: int = 1) -> None:
    if not metrics_enabled():
        return
    instrument = _instruments.get(name)
    if instrument is None:
        return
    instrument.add(value, attributes=dict(attributes))


def record_cycle(task: str, outcome: str, duration_seconds: float) -> None:
    attrs = {
        "agent.task": _normalize_task(task),
        "outcome": _normalize_outcome(outcome),
    }
    _record_histogram("cycle_duration", duration_seconds, attrs)
    _record_counter("cycle_total", attrs)


def record_tool_call(tool_name: str, outcome: str, duration_seconds: float) -> None:
    safe_tool = _normalize_tool(tool_name)
    safe_outcome = _normalize_outcome(outcome)
    attrs = {"tool.name": safe_tool, "outcome": safe_outcome}
    _record_histogram("tool_call_duration", duration_seconds, attrs)
    if outcome == "error":
        _record_counter("tool_call_errors", {"tool.name": safe_tool})


def record_llm_call(model: str, outcome: str, duration_seconds: float) -> None:
    _record_histogram(
        "llm_call_duration",
        duration_seconds,
        {
            "llm.model": _normalize_model(model),
            "outcome": _normalize_outcome(outcome),
        },
    )


def record_http_call(status_code: int, retry_count: int, duration_seconds: float) -> None:
    _record_histogram(
        "http_client_duration",
        duration_seconds,
        {
            "http.response.status_code": _normalize_status_code(str(status_code)),
            "http.retry.count": _normalize_retry_count(str(retry_count)),
        },
    )
