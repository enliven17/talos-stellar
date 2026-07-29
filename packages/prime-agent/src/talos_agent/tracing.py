"""OpenTelemetry tracing for the prime-agent.

Disabled by default (``OTEL_ENABLED`` unset/false): every helper here
degrades to a documented no-op so existing behavior, log shape, and
performance are unchanged unless an operator opts in. See
``docs/TRACING.md`` for the full design.
"""
from __future__ import annotations

import os
import re
from contextlib import contextmanager
from typing import Any, Iterator, Mapping

from opentelemetry import propagate, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
)
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

SERVICE_NAME_DEFAULT = "talos-agent"
_TRACER_NAME = "talos_agent"

# Bounded queue for the batch processor — export is backgrounded and never
# blocks the agent loop; if the queue fills (collector down/slow) new spans
# are dropped rather than applying backpressure to the request path.
_MAX_QUEUE_SIZE = 2048
_MAX_EXPORT_BATCH_SIZE = 512
_SCHEDULE_DELAY_MILLIS = 5000

_configured = False
_provider: TracerProvider | None = None


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def is_enabled() -> bool:
    return _env_bool("OTEL_ENABLED", False)


def configure_tracing() -> None:
    """Initialize the global TracerProvider exactly once per process.

    No-op (does not register a provider) unless ``OTEL_ENABLED=true``. Safe
    to call multiple times, including concurrently from ``run_multi``'s
    several ``run()`` coroutines — has no ``await`` points, so under
    asyncio's single-threaded cooperative scheduling there is no window for
    a double-registration race.

    Returns ``True`` when a real provider was configured, ``False`` when
    tracing stays a no-op (disabled or already configured).
    """
    global _configured, _provider
    if _configured:
        return
    _configured = True

    if not is_enabled():
        return

    service_name = os.getenv("OTEL_SERVICE_NAME", SERVICE_NAME_DEFAULT)
    ratio_raw = os.getenv("OTEL_TRACES_SAMPLER_ARG", "1.0")
    try:
        ratio = max(0.0, min(1.0, float(ratio_raw)))
    except ValueError:
        ratio = 1.0

    resource = Resource.create({"service.name": service_name})
    _provider = TracerProvider(
        resource=resource,
        sampler=ParentBased(TraceIdRatioBased(ratio)),
    )

    exporter_kind = os.getenv("OTEL_TRACES_EXPORTER", "otlp").strip().lower()
    if exporter_kind == "console":
        exporter = ConsoleSpanExporter()
    else:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )

        headers = _parse_otlp_headers(os.getenv("OTEL_EXPORTER_OTLP_HEADERS", ""))
        exporter = OTLPSpanExporter(headers=headers or None)

    _provider.add_span_processor(
        BatchSpanProcessor(
            exporter,
            max_queue_size=_MAX_QUEUE_SIZE,
            max_export_batch_size=_MAX_EXPORT_BATCH_SIZE,
            schedule_delay_millis=_SCHEDULE_DELAY_MILLIS,
        )
    )
    trace.set_tracer_provider(_provider)


def force_flush() -> None:
    if _provider is not None:
        try:
            _provider.force_flush()
        except Exception:
            pass


def shutdown_tracing() -> None:
    """Flush and shut down the tracer provider. Safe to call when disabled.

    Flushes any buffered spans via ``force_flush`` before calling ``shutdown``
    so the last few seconds of telemetry are not lost during graceful restarts.
    """
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


def get_tracer() -> trace.Tracer:
    return trace.get_tracer(_TRACER_NAME)


def _parse_otlp_headers(raw: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        key, _, value = pair.partition("=")
        headers[key.strip()] = value.strip()
    return headers


# ── Redaction ──────────────────────────────────────────────

_SECRET_KEY_PATTERN = re.compile(
    r"(api[_-]?key|apikey|authorization|secret|password|token|private[_-]?key|"
    r"seed|mnemonic|signature|x-payment)",
    re.IGNORECASE,
)
_MAX_ATTR_LEN = 200

_ALLOWED_ATTR_TYPES = (str, bool, int, float)


def safe_str(value: Any, max_len: int = _MAX_ATTR_LEN) -> str:
    """Stringify and truncate a value for use as a span attribute."""
    s = str(value)
    if len(s) > max_len:
        s = s[: max_len - 3] + "..."
    return s


def redact_attributes(attributes: Mapping[str, Any]) -> dict[str, Any]:
    """Drop secret-shaped keys and coerce/truncate the rest for span attributes.

    Deny-by-key rather than mask-by-key: a masked partial secret is still a
    partial secret. Never pass raw request/response bodies or LLM message
    content through this — it is a truncation/type filter, not a payload
    summarizer.
    """
    out: dict[str, Any] = {}
    for key, value in attributes.items():
        if _SECRET_KEY_PATTERN.search(key):
            continue
        if value is None:
            continue
        if isinstance(value, bool):
            out[key] = value
        elif isinstance(value, (int, float)):
            out[key] = value
        elif isinstance(value, (list, tuple)):
            out[key] = [safe_str(v, 64) for v in value[:20]]
        else:
            out[key] = safe_str(value)
    return out


# ── Span helper ────────────────────────────────────────────


@contextmanager
def traced_span(
    name: str,
    attributes: Mapping[str, Any] | None = None,
    kind: SpanKind = SpanKind.INTERNAL,
) -> Iterator[Span]:
    """Start a span, redact+set attributes, record exceptions, set status.

    A no-op (real span object, but backed by the global no-op tracer) when
    tracing is disabled — callers don't need to branch on ``is_enabled()``.
    """
    tracer = get_tracer()
    with tracer.start_as_current_span(
        name, kind=kind, record_exception=False, set_status_on_exception=False
    ) as span:
        if attributes:
            span.set_attributes(redact_attributes(attributes))
        try:
            yield span
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR, safe_str(exc, 300)))
            span.set_attribute("error.type", type(exc).__name__)
            span.record_exception(exc)
            raise
        else:
            if span.is_recording() and span.status.status_code == StatusCode.UNSET:
                span.set_status(Status(StatusCode.OK))


def inject_trace_headers(headers: dict[str, str]) -> dict[str, str]:
    """Inject the current span's W3C traceparent/tracestate into ``headers`` in place."""
    propagate.inject(headers)
    return headers
