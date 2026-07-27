# Tool Permission Manifests

Every executable agent tool declares what it may touch — data, network, wallet,
side effects — and the registry enforces that declaration at call time.

## Why

Before manifests, any registered tool could reach any host, read any local
record, and call any wallet path the runtime had credentials for. The policy
engine constrained *specific gated actions* by name, which meant a newly added
tool was unconstrained until someone remembered to add it to `_GATED_ACTIONS`.
Manifests invert that: a tool is constrained by default and must declare what it
needs.

## Declaring a manifest

```python
from talos_agent.tools.registry import tool
from talos_agent.tools.permissions import (
    DataScope, NetworkScope, SideEffect, ToolPermissions, WalletScope,
)

@tool(
    "publish_digest",
    "Publish the weekly digest to the configured channel",
    permissions=ToolPermissions(
        data=(DataScope.READ_LOCAL,),
        network=(NetworkScope.HTTP,),
        hosts=("api.example.com",),
        side_effects=(SideEffect.PUBLISH,),
    ),
)
async def publish_digest(...): ...
```

Axes and their vocabulary:

| Axis | Values |
|---|---|
| `data` | `data.none`, `read_local`, `write_local`, `read_remote`, `write_remote`, `read_secrets` |
| `network` | `network.none`, `network.http`, `network.browser` |
| `wallet` | `wallet.none`, `wallet.read`, `wallet.transfer`, `wallet.token_issue` |
| `side_effects` | `side_effect.none`, `publish`, `commerce`, `state` |

Privileged capabilities — `data.read_secrets`, `wallet.transfer`,
`wallet.token_issue`, `side_effect.commerce`, `side_effect.state` — are never
granted implicitly.

### Validation rules (enforced at registration, not first call)

- Every axis must declare at least one value; use the explicit `.NONE` member
  rather than an empty tuple.
- A network scope requires a non-empty `hosts` allowlist. "Any host" is not
  expressible as an omission — write `("*",)` if you truly mean it.
- `hosts` entries must be bare hostnames or globs (no scheme, no path).
- `wallet.transfer` requires a positive `max_spend_usd`.
- An axis may not mix `.none` with a concrete scope; that would silently read as
  "no capability".

A declared-but-invalid manifest raises `ManifestValidationError` at import.

## Grants

Grants are what the operator actually approved. The effective permission set is
the **intersection** of manifest and grants — widening a manifest can never
widen what an agent can do.

```bash
TOOL_PERMISSION_GRANTS='{
  "capabilities": ["data.read_local", "network.http", "wallet.read"],
  "hosts": ["*.stellar.org", "*.talos.xyz"],
  "max_spend_usd": "50",
  "escalate": ["side_effect.publish"]
}'
```

`escalate` forces human approval for a capability even when it is granted.

An empty `TOOL_PERMISSION_GRANTS` uses `LEGACY_GRANTS`, which reproduces
pre-manifest behaviour exactly.

## Enforcement modes

| `TOOL_PERMISSION_MODE` | Behaviour |
|---|---|
| `off` | No checks. Emergency switch. |
| `audit` | **Default.** Evaluate and record every decision; allow all calls. Denied decisions are recorded with `would_deny: true`. |
| `enforce` | Deny calls that exceed their manifest or the grants. |

Rollout is therefore: deploy on `audit`, read the audit log for
`would_deny: true` records, fix manifests and grants, then flip to `enforce`.

`registry.permissions.undeclared_tools()` returns the migration backlog — tools
still running on the empty manifest.

## Runtime decision codes

Returned to the model as a structured tool result, so the agent can react rather
than retry blindly:

| Code | Meaning |
|---|---|
| `PERMISSION_MANIFEST_MISSING` | Tool declared nothing and has no legacy entry. |
| `PERMISSION_NOT_GRANTED` | Manifest declares a capability the operator did not grant. |
| `PERMISSION_HOST_NOT_ALLOWED` | Manifest's host allowlist is not covered by the grant. |
| `PERMISSION_SPEND_LIMIT_EXCEEDED` | Requested amount exceeds `min(manifest ceiling, grant ceiling)`. |
| `PERMISSION_APPROVAL_REQUIRED` | Manifest or grant demands human approval; pass `approved=True` after it is obtained. |

The permission check runs **before** the policy engine: a tool that may not
touch a resource should never reach the rules reasoning about how it touches it.
Unlike the policy check, a permission failure is not swallowed — an enforcer that
cannot decide must not default to allow.

## Audit trail

Every evaluation emits one structured record through `audit_sink` (default: a
JSON line on the `talos_agent.tools.permissions` logger):

```json
{"ts": 1753642800.0, "tool": "transfer_xlm", "mode": "enforce",
 "declared": ["network.http", "side_effect.state", "wallet.transfer"],
 "privileged": true, "allowed": false, "code": "PERMISSION_SPEND_LIMIT_EXCEEDED",
 "capability": "wallet.transfer", "would_deny": false}
```

Argument *values* are never recorded — only the manifest surface and the
outcome — so the trail is safe to ship to a log aggregator. A failing audit sink
is logged and swallowed; it never breaks a tool call.

## Legacy migration

`LEGACY_TOOL_MANIFESTS` in `permissions.py` classifies the tools that predate
manifests, keyed by tool name, so migration did not require editing forty call
sites. That table is frozen: new tools declare inline, and the table should
shrink over time rather than grow.

## Known limitations

- The spend check reads `amount` / `amount_usd` / `price` / `value` from tool
  arguments. A tool that names its amount differently is not spend-checked here;
  the policy engine remains the authority on amounts it can see.
- Host allowlists are checked against the *manifest's* declared hosts, not the
  URL a tool actually opens at runtime. Enforcing the latter requires an
  HTTP-client interceptor and is out of scope for this layer.
- Manifests are per-tool, not per-argument; a tool that conditionally performs a
  privileged action must declare that action unconditionally.

## Rollback

Set `TOOL_PERMISSION_MODE=off`. The check short-circuits before any manifest is
consulted, and behaviour returns to pre-manifest exactly. No schema or state is
involved, so rollback is immediate and requires no migration.
