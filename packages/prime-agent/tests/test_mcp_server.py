"""Tests for the MCP server exposing selected agent tools.

Drives the server over in-memory streams with a fake registry, covering:

- initialize / ping handshake
- tools/list returns only allowlisted tools with MCP-style inputSchema
- tools/call succeeds for allowlisted read-only tools
- tools/call returns UNKNOWN_TOOL for non-allowlisted tools
- tools/call returns TOOL_DENIED when the registry returns an error
  (permission / policy denial)
- secrets are redacted from tool outputs
- the stdio run loop processes a sequence of requests correctly
"""

from __future__ import annotations

import io
import json

import pytest

from talos_agent.mcp_server import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    PROTOCOL_VERSION,
    SERVER_NAME,
    TOOL_DENIED,
    UNKNOWN_TOOL,
    MCPServer,
    _redact_secrets,
    run_stdio,
)
from talos_agent.tools.registry import Tool, ToolRegistry

# ── Fake registry helpers ─────────────────────────────────────────────────────


def _make_tool(
    name: str,
    description: str = "test tool",
    parameters: dict | None = None,
) -> Tool:
    return Tool(
        name=name,
        description=description,
        fn=lambda **kwargs: {"ok": True, "name": name, "args": kwargs},
        parameters=parameters or {"type": "object", "properties": {}},
    )


def _make_registry(tools: list[Tool], execute_result=None) -> ToolRegistry:
    """Build a fake registry with pre-populated tools and a custom execute."""
    reg = ToolRegistry()
    for t in tools:
        reg._tools[t.name] = t
    # Override execute to return a canned result or call the real fn.
    if execute_result is not None:

        async def _fake_execute(name, arguments, **kwargs):
            if name not in reg._tools:
                return {"error": f"Unknown tool: {name}"}
            return execute_result

        reg.execute = _fake_execute  # type: ignore[method-assign]
    return reg


# ══════════════════════════════════════════════════════════════════════════════
# initialize / handshake
# ══════════════════════════════════════════════════════════════════════════════


class TestInitialize:
    @pytest.mark.asyncio
    async def test_initialize_returns_server_info(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2024-11-05"},
            }
        )
        assert resp["jsonrpc"] == "2.0"
        assert resp["id"] == 1
        result = resp["result"]
        assert result["protocolVersion"] == PROTOCOL_VERSION
        assert result["serverInfo"]["name"] == SERVER_NAME
        assert "capabilities" in result

    @pytest.mark.asyncio
    async def test_initialized_notification_no_response(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}
        )
        assert resp is None

    @pytest.mark.asyncio
    async def test_ping_returns_empty(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 2, "method": "ping"}
        )
        assert resp["result"] == {}


# ══════════════════════════════════════════════════════════════════════════════
# tools/list
# ══════════════════════════════════════════════════════════════════════════════


class TestToolsList:
    @pytest.mark.asyncio
    async def test_list_returns_only_allowlisted_tools(self):
        allowed = _make_tool("discover_services", "Discover services")
        blocked = _make_tool("transfer_xlm", "Transfer XLM")
        reg = _make_registry([allowed, blocked])
        server = MCPServer(registry=reg, allowlist=frozenset({"discover_services"}))
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        tools = resp["result"]["tools"]
        assert len(tools) == 1
        assert tools[0]["name"] == "discover_services"
        assert "inputSchema" in tools[0]

    @pytest.mark.asyncio
    async def test_list_uses_default_allowlist(self):
        allowed = _make_tool("get_xlm_balance")
        blocked = _make_tool("transfer_xlm")
        reg = _make_registry([allowed, blocked])
        server = MCPServer(registry=reg)  # default allowlist
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        names = [t["name"] for t in resp["result"]["tools"]]
        assert "get_xlm_balance" in names
        assert "transfer_xlm" not in names

    @pytest.mark.asyncio
    async def test_list_empty_when_no_tools_match(self):
        reg = _make_registry([_make_tool("transfer_xlm")])
        server = MCPServer(registry=reg, allowlist=frozenset({"discover_services"}))
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        assert resp["result"]["tools"] == []


# ══════════════════════════════════════════════════════════════════════════════
# tools/call — allowlisted
# ══════════════════════════════════════════════════════════════════════════════


class TestToolsCallAllowlisted:
    @pytest.mark.asyncio
    async def test_call_allowlisted_tool_succeeds(self):
        tool = _make_tool("get_xlm_balance", "Get XLM balance")
        reg = _make_registry([tool])
        server = MCPServer(registry=reg, allowlist=frozenset({"get_xlm_balance"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "get_xlm_balance", "arguments": {}},
            }
        )
        result = resp["result"]
        assert result["isError"] is False
        assert len(result["content"]) == 1
        assert result["content"][0]["type"] == "text"
        payload = json.loads(result["content"][0]["text"])
        assert payload["ok"] is True

    @pytest.mark.asyncio
    async def test_call_with_arguments(self):
        tool = _make_tool(
            "discover_services",
            parameters={
                "type": "object",
                "properties": {"target": {"type": "string"}},
            },
        )
        reg = _make_registry([tool])
        server = MCPServer(registry=reg, allowlist=frozenset({"discover_services"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "discover_services",
                    "arguments": {"target": "marketing"},
                },
            }
        )
        payload = json.loads(resp["result"]["content"][0]["text"])
        assert payload["args"]["target"] == "marketing"


# ══════════════════════════════════════════════════════════════════════════════
# tools/call — non-allowlisted
# ══════════════════════════════════════════════════════════════════════════════


class TestToolsCallNonAllowlisted:
    @pytest.mark.asyncio
    async def test_call_non_allowlisted_returns_unknown_tool(self):
        tool = _make_tool("transfer_xlm")
        reg = _make_registry([tool])
        server = MCPServer(registry=reg, allowlist=frozenset({"discover_services"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "transfer_xlm", "arguments": {}},
            }
        )
        assert resp["error"]["code"] == UNKNOWN_TOOL
        assert "not in the MCP allowlist" in resp["error"]["message"]
        assert "transfer_xlm" in resp["error"]["message"]

    @pytest.mark.asyncio
    async def test_call_missing_name_returns_invalid_params(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"arguments": {}},
            },
        )
        assert resp["error"]["code"] == INVALID_PARAMS


# ══════════════════════════════════════════════════════════════════════════════
# tools/call — policy / permission denial
# ══════════════════════════════════════════════════════════════════════════════


class TestToolsCallPolicyDenial:
    @pytest.mark.asyncio
    async def test_policy_denial_returns_tool_denied(self):
        tool = _make_tool("purchase_service")
        reg = _make_registry(
            [tool],
            execute_result={
                "error": "Policy denied this action",
                "policy_decision": "deny",
                "evidence": ["Budget exceeded"],
            },
        )
        server = MCPServer(registry=reg, allowlist=frozenset({"purchase_service"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "purchase_service", "arguments": {"price": 999}},
            }
        )
        assert resp["error"]["code"] == TOOL_DENIED
        assert "Policy denied" in resp["error"]["message"]
        assert resp["error"]["data"]["policy_decision"] == "deny"

    @pytest.mark.asyncio
    async def test_permission_denial_returns_tool_denied(self):
        tool = _make_tool("transfer_xlm")
        reg = _make_registry(
            [tool],
            execute_result={
                "error": "Permission denied: wallet.transfer not granted",
                "code": "PERMISSION_DENIED",
                "tool": "transfer_xlm",
            },
        )
        server = MCPServer(registry=reg, allowlist=frozenset({"transfer_xlm"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "transfer_xlm", "arguments": {}},
            }
        )
        assert resp["error"]["code"] == TOOL_DENIED


# ══════════════════════════════════════════════════════════════════════════════
# Secret redaction
# ══════════════════════════════════════════════════════════════════════════════


class TestSecretRedaction:
    def test_redact_openai_key(self):
        result = _redact_secrets({"key": "sk-abc123def456ghi789jkl012mno345pqr"})
        assert "[REDACTED]" in result["key"]

    def test_redact_stellar_secret(self):
        secret = "S" + "A" * 55
        result = _redact_secrets({"secret": secret})
        assert "[REDACTED]" in result["secret"]

    def test_redact_nested(self):
        secret = "sk-" + "a" * 30
        result = _redact_secrets({"data": {"nested": {"key": secret}}})
        assert "[REDACTED]" in result["data"]["nested"]["key"]

    def test_redact_list(self):
        secret = "sk-" + "b" * 30
        result = _redact_secrets([secret, "clean"])
        assert "[REDACTED]" in result[0]
        assert result[1] == "clean"

    def test_non_string_unchanged(self):
        assert _redact_secrets(42) == 42
        assert _redact_secrets(True) is True
        assert _redact_secrets(None) is None

    @pytest.mark.asyncio
    async def test_secrets_redacted_in_tool_output(self):
        tool = _make_tool("get_config")
        secret = "sk-" + "x" * 30
        reg = _make_registry([tool], execute_result={"api_key": secret, "balance": 100})
        server = MCPServer(registry=reg, allowlist=frozenset({"get_config"}))
        resp = await server.handle_request_async(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "get_config", "arguments": {}},
            }
        )
        payload = json.loads(resp["result"]["content"][0]["text"])
        assert "[REDACTED]" in payload["api_key"]
        assert payload["balance"] == 100


# ══════════════════════════════════════════════════════════════════════════════
# Error handling
# ══════════════════════════════════════════════════════════════════════════════


class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_unknown_method(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 1, "method": "foo/bar"}
        )
        assert resp["error"]["code"] == METHOD_NOT_FOUND

    @pytest.mark.asyncio
    async def test_missing_method(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        resp = await server.handle_request_async({"jsonrpc": "2.0", "id": 1})
        assert resp["error"]["code"] == INVALID_REQUEST

    @pytest.mark.asyncio
    async def test_internal_error_caught(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)

        # Force an internal error by monkey-patching _handle_tools_list
        def _boom():
            raise RuntimeError("boom")

        server._handle_tools_list = _boom  # type: ignore[method-assign]

        resp = await server.handle_request_async(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        assert resp["error"]["code"] == INTERNAL_ERROR
        assert "boom" in resp["error"]["message"]


# ══════════════════════════════════════════════════════════════════════════════
# Stdio run loop
# ══════════════════════════════════════════════════════════════════════════════


class TestStdioRunLoop:
    @pytest.mark.asyncio
    async def test_stdio_processes_multiple_requests(self):
        tool = _make_tool("get_xlm_balance")
        reg = _make_registry([tool])
        server = MCPServer(registry=reg, allowlist=frozenset({"get_xlm_balance"}))

        # Simulate a client sending multiple JSON-RPC lines.
        stdin = io.StringIO(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            + "\n"
            + json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "get_xlm_balance", "arguments": {}},
                }
            )
            + "\n"
        )
        stdout = io.StringIO()

        await run_stdio(server, stdin=stdin, stdout=stdout)

        lines = [json.loads(l) for l in stdout.getvalue().strip().splitlines()]
        assert len(lines) == 3
        assert lines[0]["id"] == 1
        assert lines[0]["result"] == {}
        assert lines[1]["id"] == 2
        assert len(lines[1]["result"]["tools"]) == 1
        assert lines[2]["id"] == 3
        assert lines[2]["result"]["isError"] is False

    @pytest.mark.asyncio
    async def test_stdio_handles_invalid_json(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        stdin = io.StringIO("not valid json\n")
        stdout = io.StringIO()

        await run_stdio(server, stdin=stdin, stdout=stdout)

        lines = [json.loads(l) for l in stdout.getvalue().strip().splitlines()]
        assert lines[0]["error"]["code"] == PARSE_ERROR

    @pytest.mark.asyncio
    async def test_stdio_skips_notifications(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        stdin = io.StringIO(
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
            + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
            + "\n"
        )
        stdout = io.StringIO()

        await run_stdio(server, stdin=stdin, stdout=stdout)

        lines = [json.loads(l) for l in stdout.getvalue().strip().splitlines()]
        # Only the ping response, not the notification.
        assert len(lines) == 1
        assert lines[0]["id"] == 1

    @pytest.mark.asyncio
    async def test_stdio_on_line_callback(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        stdin = io.StringIO(
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n"
        )
        stdout = io.StringIO()
        captured: list[str] = []

        await run_stdio(server, stdin=stdin, stdout=stdout, on_line=captured.append)

        assert len(captured) == 1
        parsed = json.loads(captured[0])
        assert parsed["id"] == 1

    @pytest.mark.asyncio
    async def test_stdio_handles_empty_lines(self):
        reg = _make_registry([])
        server = MCPServer(registry=reg)
        stdin = io.StringIO(
            "\n\n" + json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n\n"
        )
        stdout = io.StringIO()

        await run_stdio(server, stdin=stdin, stdout=stdout)

        lines = [json.loads(l) for l in stdout.getvalue().strip().splitlines()]
        assert len(lines) == 1
