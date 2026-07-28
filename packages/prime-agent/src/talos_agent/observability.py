"""Structured logging + Sentry initialisation for the prime-agent."""
from __future__ import annotations

import logging
import os
import structlog


def _inject_trace_context(logger, method_name, event_dict):
    """Add trace_id/span_id to the log event when a recording span is active.

    No-op field-wise when tracing is disabled: get_current_span() then
    returns a non-recording span and neither key is added, so log shape is
    unchanged for anyone who hasn't opted into OTEL_ENABLED.
    """
    from opentelemetry import trace

    span = trace.get_current_span()
    ctx = span.get_span_context()
    if ctx.is_valid and span.is_recording():
        event_dict["trace_id"] = format(ctx.trace_id, "032x")
        event_dict["span_id"] = format(ctx.span_id, "016x")
    return event_dict


def configure_logging() -> None:
    """Set up structlog to emit JSON lines to stdout."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _inject_trace_context,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def init_sentry() -> None:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    import sentry_sdk
    from sentry_sdk.integrations.asyncio import AsyncioIntegration
    sentry_sdk.init(
        dsn=dsn,
        traces_sample_rate=0.1,
        integrations=[AsyncioIntegration()],
    )


def setup() -> None:
    configure_logging()
    init_sentry()

    from talos_agent import metrics as _metrics
    from talos_agent import tracing as _tracing

    _tracing.configure_tracing()
    _metrics.configure_metrics()


log = structlog.get_logger()
