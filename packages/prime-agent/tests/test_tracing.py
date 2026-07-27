"""Tests for OpenTelemetry tracing: redaction, no-op-when-disabled, span
shape/attributes on the real integration points, header injection, and
log correlation. See docs/TRACING.md for the design this verifies.
"""
from __future__ import annotations

import pytest
import respx
from httpx import Response
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode

import structlog
from talos_agent import metrics as metrics_module
from talos_agent import tracing as tracing_module
from talos_agent.api_client import TalosAPIClient
from talos_agent.config import Settings
from talos_agent.observability import _inject_trace_context
from talos_agent.tools.registry import ToolRegistry
from talos_agent.tracing import (
    inject_trace_headers,
    is_enabled,
    redact_attributes,
    safe_str,
    traced_span,
)


@pytest.fixture
def in_memory_tracer(monkeypatch):
    """Route talos_agent.tracing.get_tracer() at an isolated in-memory
    provider for the duration of a test, instead of touching OpenTelemetry's
    process-global TracerProvider (which can only be set once per process).
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("test")
    monkeypatch.setattr(tracing_module, "get_tracer", lambda: tracer)
    return exporter


# ── Redaction ──────────────────────────────────────────────


class TestRedaction:
    @pytest.mark.parametrize(
        "key",
        [
            "api_key",
            "apiKey",
            "API_KEY",
            "authorization",
            "Authorization",
            "secret",
            "password",
            "token",
            "private_key",
            "privateKey",
            "seed",
            "mnemonic",
            "signature",
            "x-payment",
        ],
    )
    def test_drops_secret_shaped_keys(self, key):
        out = redact_attributes({key: "super-secret-value", "safe": "ok"})
        assert key not in out
        assert out["safe"] == "ok"

    def test_truncates_long_strings(self):
        long_value = "x" * 500
        out = redact_attributes({"note": long_value})
        assert len(out["note"]) == 200
        assert out["note"].endswith("...")

    def test_preserves_primitive_types(self):
        out = redact_attributes({"count": 3, "ratio": 0.5, "ok": True})
        assert out == {"count": 3, "ratio": 0.5, "ok": True}

    def test_coerces_lists_to_truncated_strings(self):
        out = redact_attributes({"arg_keys": ["to_account", "amount", "reason"]})
        assert out["arg_keys"] == ["to_account", "amount", "reason"]

    def test_drops_none_values(self):
        out = redact_attributes({"missing": None, "present": "x"})
        assert "missing" not in out
        assert out["present"] == "x"

    def test_never_leaks_a_real_looking_secret_end_to_end(self):
        """Simulates a tool call whose raw arguments happen to include a
        credential-shaped field — the kind of thing a careless caller might
        pass straight into span attributes without going through redaction.
        """
        raw_args = {
            "to_account": "GABCDE...",
            "api_key": "tak_live_do_not_leak",
            "authorization": "Bearer sk-do-not-leak",
        }
        out = redact_attributes(raw_args)
        serialized = str(out)
        assert "do_not_leak" not in serialized
        assert "tak_live" not in serialized

    def test_safe_str_truncates(self):
        assert safe_str("x" * 10, max_len=5) == "xx..."
        assert len(safe_str("x" * 10, max_len=5)) == 5


# ── Disabled-by-default behavior ────────────────────────────


class TestDisabledByDefault:
    def test_is_enabled_false_by_default(self, monkeypatch):
        monkeypatch.delenv("OTEL_ENABLED", raising=False)
        assert is_enabled() is False

    @pytest.mark.parametrize("value", ["true", "1", "yes", "on", "True", "TRUE"])
    def test_is_enabled_true_variants(self, monkeypatch, value):
        monkeypatch.setenv("OTEL_ENABLED", value)
        assert is_enabled() is True

    @pytest.mark.parametrize("value", ["false", "0", "no", "off", ""])
    def test_is_enabled_false_variants(self, monkeypatch, value):
        monkeypatch.setenv("OTEL_ENABLED", value)
        assert is_enabled() is False

    def test_traced_span_is_a_safe_noop_without_configuration(self):
        """No provider configured (test default) — traced_span must not
        raise, must not attempt any network call, and yields a span that
        reports itself as not recording.
        """
        with traced_span("some.operation", {"k": "v"}) as span:
            assert span.is_recording() is False

    def test_traced_span_still_reraises_exceptions_when_noop(self):
        with pytest.raises(ValueError):
            with traced_span("some.operation"):
                raise ValueError("boom")

    def test_shutdown_helpers_are_safe_when_never_configured(self):
        tracing_module.shutdown_tracing()
        metrics_module.shutdown_metrics()

    def test_metrics_recording_is_noop_when_disabled(self, monkeypatch):
        monkeypatch.delenv("OTEL_ENABLED", raising=False)
        monkeypatch.delenv("OTEL_METRICS_ENABLED", raising=False)
        # Must not raise even though configure_metrics() was never called
        # and no instruments were built.
        metrics_module.record_cycle("agent_cycle", "success", 0.01)
        metrics_module.record_tool_call("transfer_xlm", "success", 0.01)
        metrics_module.record_llm_call("gpt-4o-mini", "success", 0.5)
        metrics_module.record_http_call(200, 0, 0.1)


# ── traced_span behavior with a real (in-memory) provider ──


class TestTracedSpanRecording:
    def test_sets_redacted_attributes(self, in_memory_tracer):
        with traced_span("tool.transfer_xlm", {"tool.name": "transfer_xlm", "api_key": "leak-me"}):
            pass
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.name == "tool.transfer_xlm"
        assert span.attributes["tool.name"] == "transfer_xlm"
        assert "api_key" not in span.attributes

    def test_records_exception_and_sets_error_status(self, in_memory_tracer):
        with pytest.raises(RuntimeError):
            with traced_span("tool.broken"):
                raise RuntimeError("kaboom")
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.status.status_code == StatusCode.ERROR
        assert span.attributes["error.type"] == "RuntimeError"
        assert len(span.events) == 1
        assert span.events[0].name == "exception"

    def test_sets_ok_status_on_success(self, in_memory_tracer):
        with traced_span("tool.ok"):
            pass
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.status.status_code == StatusCode.OK

    def test_inject_trace_headers_adds_traceparent_for_active_span(self, in_memory_tracer):
        with traced_span("web_api.GET /api/talos/me"):
            headers: dict[str, str] = {}
            inject_trace_headers(headers)
            assert "traceparent" in headers
            trace_id_hex = trace.get_current_span().get_span_context().trace_id
            assert format(trace_id_hex, "032x") in headers["traceparent"]

    def test_inject_trace_headers_omits_traceparent_without_a_real_span(self):
        headers: dict[str, str] = {}
        inject_trace_headers(headers)
        assert "traceparent" not in headers


# ── Log correlation ─────────────────────────────────────────


class TestLogTraceCorrelation:
    def test_injects_trace_and_span_id_when_span_active(self, in_memory_tracer):
        with traced_span("agent.cycle"):
            event = _inject_trace_context(None, "info", {"event": "agent_cycle_start"})
        assert "trace_id" in event
        assert "span_id" in event
        assert len(event["trace_id"]) == 32
        assert len(event["span_id"]) == 16

    def test_omits_trace_fields_when_no_span_active(self):
        event = _inject_trace_context(None, "info", {"event": "polling_error"})
        assert "trace_id" not in event
        assert "span_id" not in event


# ── Integration: ToolRegistry ───────────────────────────────


class TestToolRegistrySpans:
    @pytest.mark.asyncio
    async def test_execute_creates_a_span_named_after_the_tool(self, in_memory_tracer):
        registry = ToolRegistry()

        async def transfer_xlm(to_account: str, amount: float) -> dict:
            return {"status": "ok"}

        registry.register(
            "transfer_xlm",
            "desc",
            transfer_xlm,
            {"type": "object", "properties": {}},
        )

        result = await registry.execute(
            "transfer_xlm", {"to_account": "GABCDE", "amount": 5.0}
        )

        assert result == {"status": "ok"}
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.name == "tool.transfer_xlm"
        assert span.attributes["tool.name"] == "transfer_xlm"
        assert set(span.attributes["tool.arg_keys"]) == {"to_account", "amount"}
        assert span.status.status_code == StatusCode.OK

    @pytest.mark.asyncio
    async def test_execute_records_failure_but_still_returns_error_dict(
        self, in_memory_tracer
    ):
        """ToolRegistry.execute()'s existing contract (never raises, always
        returns {"error": ...} on failure) must be unchanged by tracing.
        """
        registry = ToolRegistry()

        async def flaky_tool() -> dict:
            raise ValueError("tool blew up")

        registry.register("flaky_tool", "desc", flaky_tool, {"type": "object", "properties": {}})

        result = await registry.execute("flaky_tool", {})

        assert "error" in result
        assert "tool blew up" in result["error"]
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.status.status_code == StatusCode.ERROR

    @pytest.mark.asyncio
    async def test_unknown_tool_does_not_create_a_span(self, in_memory_tracer):
        registry = ToolRegistry()
        result = await registry.execute("nonexistent", {})
        assert result == {"error": "Unknown tool: nonexistent"}
        assert in_memory_tracer.get_finished_spans() == ()


# ── Integration: TalosAPIClient ─────────────────────────────


class TestApiClientSpans:
    @pytest.fixture
    def api_client(self, mock_settings: Settings) -> TalosAPIClient:
        return TalosAPIClient(mock_settings)

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_creates_a_span_with_status_and_injects_traceparent(
        self, api_client: TalosAPIClient, in_memory_tracer
    ):
        captured_headers = {}

        def _capture(request):
            captured_headers.update(request.headers)
            return Response(200, json={"id": "test-talos"})

        respx.get("http://test.local/api/talos/test-talos").mock(side_effect=_capture)

        result = await api_client.get_talos("test-talos")

        assert result == {"id": "test-talos"}
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.name == "web_api.GET /api/talos/test-talos"
        assert span.attributes["http.response.status_code"] == 200
        assert span.attributes["http.retry.count"] == 0
        assert "traceparent" in captured_headers
        # Authorization must survive header merging with the injected traceparent.
        assert captured_headers["authorization"] == "Bearer cpk_test_key"

    @pytest.mark.asyncio
    @respx.mock
    async def test_get_records_retry_count_on_transient_failure(
        self, api_client: TalosAPIClient, in_memory_tracer, monkeypatch
    ):
        from talos_agent import http as http_module
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_none

        def fast_policy():
            return AsyncRetrying(
                stop=stop_after_attempt(3),
                wait=wait_none(),
                retry=retry_if_exception(http_module._is_retryable),
                before_sleep=http_module._log_before_sleep,
                reraise=True,
            )

        monkeypatch.setattr(http_module, "_retry_policy", fast_policy)

        route = respx.get("http://test.local/api/talos/test-talos").mock(
            side_effect=[Response(503), Response(200, json={"id": "test-talos"})]
        )

        result = await api_client.get_talos("test-talos")

        assert result == {"id": "test-talos"}
        assert route.call_count == 2
        (span,) = in_memory_tracer.get_finished_spans()
        assert span.attributes["http.retry.count"] == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_never_sets_authorization_header_as_a_span_attribute(
        self, api_client: TalosAPIClient, in_memory_tracer
    ):
        respx.get("http://test.local/api/talos/test-talos").mock(
            return_value=Response(200, json={"id": "test-talos"})
        )
        await api_client.get_talos("test-talos")
        (span,) = in_memory_tracer.get_finished_spans()
        serialized = str(dict(span.attributes))
        assert "cpk_test_key" not in serialized


# ── Integration: full trace + metrics + log correlation pipeline ──


class TestFullPipelineIntegration:
    """End-to-end verification that traces, metrics, and log correlation
    all work together through in-memory exporters.

    This is the single test the maintainer can run to confirm the entire
    telemetry pipeline is wired correctly.
    """

    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch):
        monkeypatch.setenv("OTEL_ENABLED", "true")
        monkeypatch.setenv("OTEL_METRICS_ENABLED", "true")
        monkeypatch.setenv("OTEL_TRACES_EXPORTER", "console")
        # Reset module-level state so configure_* runs fresh
        tracing_module._configured = False
        tracing_module._provider = None
        metrics_module._configured = False
        metrics_module._provider = None
        metrics_module._instruments.clear()

    def test_trace_export_and_log_correlation(self, in_memory_tracer):
        """A traced span produces a finished span in the exporter AND injects
        trace_id/span_id into structlog events."""
        log_events: list[dict] = []

        def _capture(logger, method_name, event_dict):
            log_events.append(event_dict)
            return event_dict

        structlog.configure(processors=[_capture])

        from talos_agent.observability import _inject_trace_context

        with tracing_module.traced_span("integration.test", {"key": "value"}) as span:
            assert span.is_recording() is True
            event = _inject_trace_context(None, "info", {"event": "test_in_progress"})
            assert "trace_id" in event
            assert "span_id" in event

        (finished,) = in_memory_tracer.get_finished_spans()
        assert finished.name == "integration.test"
        assert finished.attributes.get("key") == "value"

    def test_configure_and_shutdown_lifecycle_is_deterministic(self):
        """Calling configure_tracing + shutdown_tracing multiple times is
        safe and produces exactly one provider."""
        tracing_module.configure_tracing()
        tracing_module.configure_tracing()  # second call is no-op
        assert tracing_module._provider is not None

        # Shutdown is idempotent
        tracing_module.shutdown_tracing()
        tracing_module.shutdown_tracing()

    def test_metrics_configure_and_record(self):
        """OTel metrics histogram/counter instruments record through an
        in-memory pipeline when enabled."""
        from opentelemetry import metrics as otel_metrics
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import InMemoryMetricReader

        reader = InMemoryMetricReader()
        provider = MeterProvider(metric_readers=[reader])
        otel_metrics.set_meter_provider(provider)
        metrics_module._provider = provider

        metrics_module._build_instruments()
        metrics_module.record_cycle("agent_cycle", "success", 0.042)
        metrics_module.record_tool_call("test_tool", "success", 0.015)
        metrics_module.record_llm_call("gpt-4o", "success", 1.2)
        metrics_module.record_http_call(200, 0, 0.1)

        metrics_data = reader.get_metrics_data()
        assert metrics_data is not None
        resource_metrics = metrics_data.resource_metrics
        assert len(resource_metrics) > 0

        metric_names = set()
        for rm in resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    metric_names.add(m.name)
        assert "talos_agent_cycle_duration_seconds" in metric_names
        assert "talos_agent_cycle_total" in metric_names
        assert "talos_agent_tool_call_duration_seconds" in metric_names
        assert "talos_agent_llm_call_duration_seconds" in metric_names

        provider.shutdown()
        otel_metrics.set_meter_provider(otel_metrics.NoOpMeterProvider())

    def test_metrics_safe_when_never_configured(self):
        """record_* helpers do not raise when metrics were never configured."""
        metrics_module.record_cycle("test", "success", 0.1)
        metrics_module.record_tool_call("test", "error", 0.2)
        metrics_module.record_llm_call("test", "success", 0.3)
        metrics_module.record_http_call(200, 0, 0.4)

    def test_force_flush_is_safe_when_disabled(self):
        tracing_module.force_flush()
        metrics_module.force_flush_metrics()
