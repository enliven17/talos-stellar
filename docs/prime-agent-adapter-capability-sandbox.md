# Prime-agent adapter capability sandbox

Status: implementation design for issue #228.

## Threat model and boundary

Social adapters are integration code for third-party services. They must not
inherit ambient access to every agent credential, arbitrary network
destinations, the local filesystem, browser navigation, or agent tools.

The capability sandbox is enforced at the adapter registry boundary:

```text
publishing tool
    -> sandboxed adapter proxy (operation, timeout, concurrency, I/O bounds)
        -> adapter
            -> scoped secrets
            -> allowlisted HTTP or browser facade
```

Adapters do not receive `Settings`, `LocalDB`, the tool registry, raw HTTP
clients, or the unrestricted browser when enforcement is enabled. Unknown
adapters have no manifest and registration fails closed.

The built-in Python adapters remain trusted package code. Python does not
provide a secure in-process memory boundary against malicious introspection or
an adapter that imports `socket`, `httpx`, or `os` itself. The sandbox makes all
supported adapter I/O explicit and testable; genuinely untrusted third-party
code still requires a separate OS/container process. This limitation is
intentional and documented rather than overstating in-process isolation.

## Capability manifest

`AdapterCapabilityManifest` is an immutable typed interface containing:

- adapter identifier and allowed adapter operations;
- secret names available through `ScopedSecretProvider`;
- HTTPS network rules (exact host, optional port, path prefix, methods);
- browser host and browser-action rules;
- filesystem read/write roots (empty for all built-in adapters);
- agent tool names (empty for all built-in adapters);
- maximum input bytes, output bytes/items, network requests, concurrency,
  invocation timeout, and durable lease duration.

Manifests reject unknown fields, unsafe identifiers, userinfo in URLs, wildcard
hosts, non-HTTPS schemes, unbounded values, and path traversal. Runtime
configuration can replace a built-in manifest only while sandboxing is enabled;
an omitted field grants nothing. Operators therefore cannot accidentally
inherit an ambient capability.

Built-in policy:

| Adapter | Secrets | Network/browser | Files/tools |
| --- | --- | --- | --- |
| Discord | webhook URL, bot token | `https://discord.com/api/`, `https://discordapp.com/api/` | none |
| Telegram | bot token | `https://api.telegram.org/` | none |
| X | password | browser actions on `x.com` only | none |

Channel IDs, guild IDs, usernames, and chat IDs are bounded non-secret
configuration values injected separately.

## Durable invocation state

Migration 8 adds `adapter_invocations`. Write operations (`post` and `reply`)
are admitted using a caller-provided operation ID and an input digest. A
`BEGIN IMMEDIATE` transaction provides cross-process compare-and-swap:

1. A new ID becomes `running` with an owner and bounded lease.
2. A duplicate with different adapter, operation, or digest is a conflict.
3. A duplicate while its lease is live is busy.
4. A duplicate after success is rejected as already completed.
5. An expired lease or an interrupted/timeout write becomes `indeterminate`;
   it is never automatically replayed because the provider may have accepted
   the first request.

No content, URL, result, credential, ciphertext, or user payload is persisted.
Only identifiers, state, timestamps, attempt count, and a SHA-256 input digest
are stored. Read-only operations do not require durable admission.

The database remains the correctness authority across processes and restarts.
The in-process semaphore is only a resource bound.
Callers that may redeliver work must pass the same stable `operation_id`;
omitting it intentionally generates a new ID for a one-shot interactive call.

## Enforcement and failure behavior

- Network checks happen before every HTTP call. Redirects are disabled.
- URL rules use exact normalized hostnames and bounded paths; credentials and
  fragments in URLs are rejected.
- Browser navigation checks every adapter-requested destination. Supported
  facades expose only declared browser actions.
- Secret lookup checks the manifest on every read, preserving encrypted secret
  rotation from issue #227 without exposing unrelated credentials.
- Each invocation gets an isolated `contextvars` budget. Concurrent adapters
  cannot consume each other's request allowance.
- Timeouts before external I/O mark writes `failed` and permit an explicit
  same-ID retry. Timeouts after external I/O starts mark writes
  `indeterminate`.
- Oversized inputs are rejected before adapter code runs. Oversized outputs are
  replaced with a typed failure and never logged.
- Logs contain adapter, operation, capability, outcome, error class, duration,
  and operation ID. They never contain secrets, URLs, content, query strings,
  headers, or returned payloads.

## Configuration and rollout

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `TALOS_ADAPTER_SANDBOX_ENABLED` | `false` | Enables capability enforcement. |
| `TALOS_ADAPTER_CAPABILITY_MANIFESTS` | empty | JSON manifest replacements keyed by adapter ID. |
| `TALOS_ADAPTER_TIMEOUT_SECONDS` | `30` | Default invocation timeout, hard-capped at 120 seconds. |
| `TALOS_ADAPTER_MAX_CONCURRENCY` | `2` | Default per-adapter concurrency, hard-capped at 16. |
| `TALOS_ADAPTER_MAX_INPUT_BYTES` | `16384` | Default serialized input limit, hard-capped at 1 MiB. |
| `TALOS_ADAPTER_MAX_OUTPUT_BYTES` | `262144` | Default serialized output limit, hard-capped at 2 MiB. |
| `TALOS_ADAPTER_MAX_NETWORK_REQUESTS` | `8` | Per-invocation request limit, hard-capped at 32. |
| `TALOS_ADAPTER_INVOCATION_LEASE_SECONDS` | `120` | Durable write lease, hard-capped at 15 minutes. |
| `TALOS_ADAPTER_MAX_INVOCATION_RECORDS` | `100000` | Hard bound for durable invocation records, capped at one million. |

Backward-compatible rollout:

1. Deploy with sandboxing disabled; migration 8 is additive.
2. Inspect built-in manifests and any configured replacements locally.
3. Enable sandboxing with the built-in policies.
4. Watch capability-denied, timeout, resource-limit, and indeterminate signals.
5. Tighten replacement manifests only after representative traffic succeeds.

Disabling `TALOS_ADAPTER_SANDBOX_ENABLED` restores the legacy construction path
without deleting invocation history. This is the code rollback. Provider-side
actions already accepted cannot be undone by this switch.

## Operational signals

- `adapter_sandbox_invocation`: admitted, succeeded, failed, timed out, busy,
  duplicate, or indeterminate.
- `adapter_capability_denied`: operation, secret, network, browser, filesystem,
  or tool capability denied.
- `adapter_resource_limit`: input, output, request, concurrency, or timeout
  bound reached.

All signals use names and error types only. Metrics can count these structured
events by adapter, operation, capability, and outcome.

## Recovery and rollback

For `indeterminate` writes, reconcile against the provider using its message ID,
audit UI, or channel history. Use a new operation ID only after confirming the
original action did not occur. Reusing the old ID remains blocked by design.

For a bad manifest, restore the previous JSON or remove the replacement to use
the built-in policy, then restart the agent so adapter construction is atomic.
For urgent rollback, disable sandboxing and restart. Encrypted secret rotation
continues to work independently.

## Local verification

From `packages/prime-agent`:

```bash
uv sync --extra dev
uv run pytest tests/test_adapter_capability_sandbox.py
uv run pytest
uv run ruff check src tests
```

Escape tests cover cross-secret access, cross-host, IP-literal, alternate-port,
URL-userinfo and traversal requests, filesystem and tool denial, input bounds,
timeouts before and after external effects, stale leases, restart recovery,
redaction, and duplicate delivery at the publishing module boundary.

## Known limitations

- This is not an OS sandbox for arbitrary malicious Python packages.
- DNS rebinding protection relies on exact trusted service hostnames and
  redirects being disabled; custom hosts should be isolated at the network
  layer as well.
- Browser-initiated subresources and server redirects are controlled by the
  browser engine. The facade constrains adapter-requested top-level navigation.
- External providers in scope do not expose a common idempotency protocol, so a
  crash after provider acceptance is deliberately `indeterminate`, not retried.
- Durable invocation history has a hard record cap. Export required audit
  history and delete old terminal rows during a maintenance window before the
  cap is reached; never delete `running` or `indeterminate` rows without
  provider reconciliation.
