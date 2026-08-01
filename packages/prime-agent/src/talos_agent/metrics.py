"""OpenTelemetry metrics for the prime-agent — a small, bounded instrument set.

Disabled by default (``OTEL_METRICS_ENABLED`` unset/false, and gated behind
``OTEL_ENABLED`` overall — see ``tracing.py``/``docs/TRACING.md``). All
attribute values used here are fixed, low-cardinality dimensions (task
names, tool names, HTTP status codes, model names) — never account IDs, job
IDs, or free text — to keep cardinality bounded on the receiving backend.
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
    attrs = {"agent.task": task, "outcome": outcome}
    _record_histogram("cycle_duration", duration_seconds, attrs)
    _record_counter("cycle_total", attrs)


def record_tool_call(tool_name: str, outcome: str, duration_seconds: float) -> None:
    attrs = {"tool.name": tool_name, "outcome": outcome}
    _record_histogram("tool_call_duration", duration_seconds, attrs)
    if outcome == "error":
        _record_counter("tool_call_errors", {"tool.name": tool_name})


def record_llm_call(model: str, outcome: str, duration_seconds: float) -> None:
    _record_histogram(
        "llm_call_duration", duration_seconds, {"llm.model": model, "outcome": outcome}
    )


def record_http_call(status_code: int, retry_count: int, duration_seconds: float) -> None:
    _record_histogram(
        "http_client_duration",
        duration_seconds,
        {
            "http.response.status_code": str(status_code),
            "http.retry.count": str(retry_count),
        },
    )
