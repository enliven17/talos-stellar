# MCP Server

The prime agent exposes an optional Model Context Protocol (MCP) server
over stdio, allowing external MCP-compatible clients (Claude Desktop,
Cursor, etc.) to discover and call selected agent tools.

## Quick start

```bash
cd packages/prime-agent
uv run talos-agent mcp
```

The server reads from stdin and writes JSON-RPC 2.0 responses to stdout.
Diagnostic messages go to stderr so they don't interfere with the
protocol stream.

## Allowlist

By default, only read-only / side-effect-free tools are exposed:

| Tool | Description |
|------|-------------|
| `discover_services` | Browse the inter-Talos marketplace |
| `get_pending_jobs` | List pending commerce jobs |
| `get_publishing_channels` | List available publishing channels |
| `evaluate_marketplace_bid` | Evaluate a marketplace bid |
| `get_xlm_balance` | Read XLM balance |
| `get_pulse_balance` | Read Pulse token balance |
| `get_active_loans` | List active DeFi loans |
| `check_approval` | Check approval status |
| `get_content_history` | Read recent content history |
| `get_schedule_status` | Today's activity counts |
| `get_active_playbook` | Current GTM playbook |
| `check_x_mentions` | Read X mentions |
| `check_post_performance` | Read post engagement |
| `poll_service_result` | Poll a purchased service result |
| `plan_purchase` | Plan a purchase (no execution) |
| `normalize_providers` | Normalize provider names |

Tools not on the allowlist are invisible to MCP clients — they do not
appear in `tools/list` and `tools/call` returns a structured
`UNKNOWN_TOOL` error.

## Customising the allowlist

### CLI flags

```bash
# Add tools to the default allowlist
talos-agent mcp --allow get_xlm_balance --allow get_pulse_balance

# Replace the allowlist entirely
talos-agent mcp --allow-only discover_services --allow-only get_pending_jobs
```

### Environment variables

```bash
# Add to the default allowlist
TALOS_MCP_ALLOWLIST_EXTRA=discover_services,get_pending_jobs

# Override the allowlist entirely
TALOS_MCP_ALLOWLIST_ONLY=discover_services,get_pending_jobs
```

## Permission and policy enforcement

Every tool call goes through `ToolRegistry.execute`, which applies:

1. **Permission manifest check** — the tool's declared capabilities
   are validated against the operator's grants. A tool that declares a
   capability it was not granted is denied.
2. **Policy engine pre-check** — gated actions (transfers, purchases,
   publishing) are evaluated against loaded policy rules. Denied or
   escalated actions return structured errors.

This means the MCP server inherits the same enforcement as the internal
agent loop — the MCP layer does not duplicate or bypass any checks.

## Secret safety

Tool outputs are sanitised before serialisation:

- Values matching credential patterns (OpenAI keys, Stellar secret keys,
  GitHub tokens, Bearer tokens) are replaced with `[REDACTED]`.
- No secret material appears in `tools/list` output.
- Policy denial errors include only decision metadata, never argument
  values.

## Protocol

The server speaks JSON-RPC 2.0 over line-delimited stdio:

### `initialize`

```jsonc
// Request
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
// Response
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"talos-agent-mcp","version":"0.1.0"}}}
```

### `tools/list`

```jsonc
// Request
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
// Response
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"discover_services","description":"...","inputSchema":{...}}]}}
```

### `tools/call`

```jsonc
// Request
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"discover_services","arguments":{}}}
// Response (success)
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"services\":[...]}"}],"isError":false}}
// Response (denied)
{"jsonrpc":"2.0","id":3,"error":{"code":-32002,"message":"Policy denied this action","data":{"policy_decision":"deny","evidence":[...]}}}
```

### Error codes

| Code | Meaning |
|------|---------|
| -32700 | Parse error (invalid JSON) |
| -32600 | Invalid request (missing method) |
| -32601 | Method not found |
| -32602 | Invalid params (missing tool name) |
| -32603 | Internal error |
| -32001 | Unknown tool (not in allowlist) |
| -32002 | Tool denied (permission or policy) |

## Out of scope

- HTTP/SSE MCP transport is not supported (stdio only).
- The server does not expose resources or prompts — only tools.
