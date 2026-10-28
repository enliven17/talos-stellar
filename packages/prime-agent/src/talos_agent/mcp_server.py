"""Minimal stdio MCP server exposing allowlisted agent tools.

Implements the Model Context Protocol (MCP) JSON-RPC 2.0 subset over
stdio:

  - ``initialize`` / ``initialized`` — protocol handshake
  - ``tools/list`` — list allowlisted tools with their JSON schemas
  - ``tools/call`` — invoke a tool through the existing ToolRegistry,
    enforcing permission manifests and policy middleware on every call
  - ``ping`` — liveness probe

Design notes
------------
* **No new runtime dependencies.** The server speaks line-delimited
  JSON-RPC 2.0 directly over ``sys.stdin`` / ``sys.stdout`` so the
  agent's dependency tree stays unchanged.
* **Allowlist is the only entry point.** Tools not on the allowlist are
  invisible to MCP clients — they do not appear in ``tools/list`` and
  ``tools/call`` returns a structured ``UNKNOWN_TOOL`` error.
* **Secrets never reach the wire.`` Tool outputs are sanitised before
  serialisation: values matching credential patterns are replaced with
  ``[REDACTED]``.
* **Policy enforcement is reused.`` Every call goes through
  ``ToolRegistry.execute`` which already runs the permission enforcer
  and policy middleware — the MCP layer does not duplicate that logic.
"""

from __future__ import annotations

import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TextIO

from talos_agent.tools.registry import ToolRegistry

# ── Constants ────────────────────────────────────────────────────────────────

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "talos-agent-mcp"
SERVER_VERSION = "0.1.0"

#: Default allowlist — read-only / side-effect-free tools safe for
#: external MCP clients.  These match the ``_BYPASS_ACTIONS`` set in the
#: policy middleware plus discovery / planning tools that do not move
#: funds or publish content.
DEFAULT_ALLOWLIST: frozenset[str] = frozenset(
    {
        # Discovery
        "discover_services",
        "get_pending_jobs",
        "get_publishing_channels",
        "evaluate_marketplace_bid",
        # Balances / state (read-only)
        "get_xlm_balance",
        "get_pulse_balance",
        "get_active_loans",
        "check_approval",
        # Content / scheduling (read-only)
        "get_content_history",
        "get_schedule_status",
        "get_active_playbook",
        "check_x_mentions",
        "check_post_performance",
        "poll_service_result",
        # Planning (read-only, no side effects)
        "plan_purchase",
        "normalize_providers",
    }
)

# Patterns that indicate a secret value that must never appear in MCP
# tool outputs.
_SECRET_PATTERNS = re.compile(
    r"(?i)"
    r"(sk-[a-zA-Z0-9]{20,})"  # OpenAI-style keys
    r"|(S[A-Z2-7]{55,})"  # Stellar secret keys
    r"|(gh[pousr]_[A-Za-z0-9]{36,})"  # GitHub tokens
    r"|(Bearer\s+[A-Za-z0-9\-._~+/=]+)"  # Bearer tokens
)
_REDACTED = "[REDACTED]"


def _redact_secrets(value: Any) -> Any:
    """Recursively replace secret-like strings in tool outputs."""
    if isinstance(value, str):
        return _SECRET_PATTERNS.sub(_REDACTED, value)
    if isinstance(value, dict):
        return {k: _redact_secrets(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_secrets(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_secrets(v) for v in value)
    return value


# ── JSON-RPC errors ──────────────────────────────────────────────────────────

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# MCP-specific errors (use the -32000 to -32099 band)
UNKNOWN_TOOL = -32001
TOOL_DENIED = -32002


def _error(code: int, message: str, data: Any | None = None) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return err


def _response(
    req_id: Any, result: Any | None = None, error: dict[str, Any] | None = None
) -> dict[str, Any]:
    resp: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        resp["error"] = error
    else:
        resp["result"] = result
    return resp


# ── MCP server ───────────────────────────────────────────────────────────────


@dataclass
class MCPServer:
    """Stateful stdio MCP server wrapping a :class:`ToolRegistry`.

    Parameters
    ----------
    registry
        The agent's :class:`ToolRegistry`. Tool calls go through
        ``registry.execute`` so permission and policy checks are
        enforced identically to the internal agent loop.
    allowlist
        Set of tool names exposed to MCP clients. Defaults to
        :data:`DEFAULT_ALLOWLIST`.
    """

    registry: ToolRegistry
    allowlist: frozenset[str] = field(default_factory=lambda: DEFAULT_ALLOWLIST)
    _initialized: bool = field(default=False, init=False)

    # ── Public API ─────────────────────────────────────────────────────────

    def handle_request(
        self, request: dict[str, Any]
    ) -> dict[str, Any] | list[dict[str, Any]] | None:
        """Dispatch a single JSON-RPC request (or batch) and return a response.

        Returns ``None`` for notifications (requests without ``id``).
        """
        if not isinstance(request, dict):
            return _response(
                None, error=_error(PARSE_ERROR, "Request must be a JSON object")
            )

        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        is_notification = req_id is None and "id" not in request

        # Batch request
        if isinstance(request, list):
            return [
                r for r in (self.handle_request(r) for r in request) if r is not None
            ]  # type: ignore[arg-type]

        if not method or not isinstance(method, str):
            return _response(
                req_id, error=_error(INVALID_REQUEST, "Missing or invalid 'method'")
            )

        try:
            result = self._dispatch(method, params, is_notification=is_notification)
        except _MCPError as exc:
            return _response(req_id, error=_error(exc.code, exc.message, exc.data))
        except Exception as exc:  # noqa: BLE001 - JSON-RPC boundary: catch-all
            return _response(
                req_id, error=_error(INTERNAL_ERROR, f"Internal error: {exc}")
            )

        if is_notification:
            return None
        return _response(req_id, result=result)

    async def handle_request_async(
        self, request: dict[str, Any]
    ) -> dict[str, Any] | list[dict[str, Any]] | None:
        """Async dispatch for tool calls that may be coroutines."""
        if not isinstance(request, dict):
            return _response(
                None, error=_error(PARSE_ERROR, "Request must be a JSON object")
            )

        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        is_notification = req_id is None and "id" not in request

        if not method or not isinstance(method, str):
            return _response(
                req_id, error=_error(INVALID_REQUEST, "Missing or invalid 'method'")
            )

        try:
            result = await self._dispatch_async(
                method, params, is_notification=is_notification
            )
        except _MCPError as exc:
            return _response(req_id, error=_error(exc.code, exc.message, exc.data))
        except Exception as exc:  # noqa: BLE001 - JSON-RPC boundary: catch-all
            return _response(
                req_id, error=_error(INTERNAL_ERROR, f"Internal error: {exc}")
            )

        if is_notification:
            return None
        return _response(req_id, result=result)

    # ── Sync dispatch (initialize, list, ping) ─────────────────────────────

    def _dispatch(
        self, method: str, params: dict[str, Any], *, is_notification: bool
    ) -> Any:
        if method == "initialize":
            return self._handle_initialize(params)
        if method == "notifications/initialized":
            self._initialized = True
            return None
        if method == "ping":
            return {}
        if method == "tools/list":
            return self._handle_tools_list()
        if method == "tools/call":
            # Delegate to async path
            raise _MCPError(INVALID_REQUEST, "Use handle_request_async for tools/call")
        raise _MCPError(METHOD_NOT_FOUND, f"Unknown method: {method}")

    async def _dispatch_async(
        self, method: str, params: dict[str, Any], *, is_notification: bool
    ) -> Any:
        if method == "initialize":
            return self._handle_initialize(params)
        if method == "notifications/initialized":
            self._initialized = True
            return None
        if method == "ping":
            return {}
        if method == "tools/list":
            return self._handle_tools_list()
        if method == "tools/call":
            return await self._handle_tools_call(params)
        raise _MCPError(METHOD_NOT_FOUND, f"Unknown method: {method}")

    # ── Method handlers ───────────────────────────────────────────────────

    def _handle_initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        client_protocol = params.get("protocolVersion")
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": {"listChanged": False},
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
            },
            # Echo back the client's protocol version if it's compatible.
            "clientProtocolVersion": client_protocol,
        }

    def _handle_tools_list(self) -> dict[str, Any]:
        tools = []
        for tool in self.registry.all_tools():
            if tool.name not in self.allowlist:
                continue
            schema = tool.to_openai_schema()
            # MCP uses "inputSchema" instead of "parameters"
            tools.append(
                {
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": schema["function"]["parameters"],
                }
            )
        return {"tools": tools}

    async def _handle_tools_call(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        arguments = params.get("arguments") or {}

        if not name or not isinstance(name, str):
            raise _MCPError(
                INVALID_PARAMS, "Missing or invalid 'name' in tools/call params"
            )

        # Allowlist check — this is the first gate.
        if name not in self.allowlist:
            raise _MCPError(
                UNKNOWN_TOOL,
                f"Tool '{name}' is not in the MCP allowlist",
                data={"allowed_tools": sorted(self.allowlist)},
            )

        tool = self.registry.get(name)
        if tool is None:
            raise _MCPError(
                UNKNOWN_TOOL,
                f"Tool '{name}' is registered in the allowlist but not in the registry",
            )

        # Execute through the registry — this runs the permission enforcer
        # and policy middleware, exactly as the internal agent loop does.
        result = await self.registry.execute(name, arguments)

        # Sanitise secrets before they reach the wire.
        result = _redact_secrets(result)

        # Structure the result per MCP conventions.
        if isinstance(result, dict) and "error" in result:
            # Permission or policy denial — return as a structured error.
            raise _MCPError(
                TOOL_DENIED,
                str(result.get("error", "Tool call denied")),
                data={
                    "code": result.get("code"),
                    "tool": result.get("tool", name),
                    "policy_decision": result.get("policy_decision"),
                    "evidence": result.get("evidence"),
                },
            )

        # Successful result — wrap in MCP content format.
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(result, default=str),
                }
            ],
            "isError": False,
        }


# ── Internal error type ─────────────────────────────────────────────────────


class _MCPError(Exception):
    """JSON-RPC error with a code, message, and optional data."""

    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        self.code = code
        self.message = message
        self.data = data
        super().__init__(message)


# ── Stdio run loop ────────────────────────────────────────────────────────────


def _read_lines(stream: TextIO) -> list[str]:
    """Read all available lines from a stream (non-blocking for testing)."""
    return stream.readlines()


async def run_stdio(
    server: MCPServer,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    on_line: Callable[[str], None] | None = None,
) -> None:
    """Run the MCP server on stdio.

    Reads line-delimited JSON-RPC from ``stdin`` and writes responses to
    ``stdout``. Exits cleanly on EOF.

    Parameters
    ----------
    stdin, stdout
        Override the input/output streams (useful for testing).
    on_line
        Optional callback invoked with each outgoing JSON line (useful
        for testing assertions without parsing stdout).
    """
    in_stream = stdin or sys.stdin
    out_stream = stdout or sys.stdout

    for raw_line in in_stream:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = _response(
                None, error=_error(PARSE_ERROR, f"Invalid JSON: {exc}")
            )
            out_line = json.dumps(response)
            print(out_line, file=out_stream, flush=True)
            if on_line:
                on_line(out_line)
            continue

        response = await server.handle_request_async(request)
        if response is None:
            continue  # notification, no response

        if isinstance(response, list):
            for r in response:
                out_line = json.dumps(r)
                print(out_line, file=out_stream, flush=True)
                if on_line:
                    on_line(out_line)
        else:
            out_line = json.dumps(response)
            print(out_line, file=out_stream, flush=True)
            if on_line:
                on_line(out_line)


def build_mcp_server(
    registry: ToolRegistry,
    allowlist: frozenset[str] | None = None,
) -> MCPServer:
    """Build an :class:`MCPServer` from a registry and optional allowlist."""
    return MCPServer(
        registry=registry,
        allowlist=allowlist or DEFAULT_ALLOWLIST,
    )
