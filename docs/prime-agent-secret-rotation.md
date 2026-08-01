# Prime-agent encrypted secret rotation

Status: implementation design for issue #227.

## Goals and boundary

The prime-agent must rotate agent API keys, LLM/provider credentials, channel
credentials, and locally managed wallet credentials without persisting
plaintext or restarting the agent. Rotation is opt-in so existing `.env` and
`config.json` installations continue to work until an operator migrates them.

The boundary is the prime-agent's existing SQLite database and `Settings`
object. A separate secrets service is deliberately not required for local
agents. When operators put the database on shared storage, SQLite's locking
semantics remain the source of truth; correctness never depends on a
process-local cache.

## Data model and encryption

Migration 7 adds:

- `secret_versions`: immutable encrypted versions and their lifecycle state.
- `secret_heads`: one atomic active/previous pointer and generation per secret.
- `secret_audit_events`: append-only, idempotent transition records. Events
  contain names, versions, actors, outcomes, and bounded metadata only.

Values use AES-256-GCM with a fresh 96-bit nonce. The authenticated data binds
the envelope format, scope, secret name, version, and key ID, preventing a
ciphertext from being moved to another row. Encryption keys are supplied as a
JSON keyring in `TALOS_SECRET_KEYRING`; the database stores only the key ID,
nonce, and ciphertext. Keys must be 32 random bytes encoded with URL-safe
base64. The keyring and plaintext are never logged or written to SQLite.

The database file is created with owner-only permissions where the platform
supports them. Database permissions are defense in depth: confidentiality
still depends on keeping the encryption keyring outside the database.

## State machine

```text
             stage               activate (CAS)
  absent  ------------> staged --------------------> active
                              duplicate request ID      |
                                                       | next activation
                                                       v
                                                   superseded
                                                       |
                              recover (CAS) <-----------+

  staged/superseded -- revoke --> revoked
  active -- revoke --> rejected (recover/activate another version first)
```

`stage`, `activate`, `revoke`, and `recover` use `BEGIN IMMEDIATE` transactions.
Activation accepts an expected active version. A stale operator therefore gets
an explicit conflict instead of overwriting a concurrent rotation. A unique
`request_id` makes retried or duplicate stage delivery return the original
version. SQLite's configured busy timeout bounds lock waiting.

No external provider is called inside a database transaction. A staged value
may be verified against its provider before activation; failed validation
leaves it staged and the current credential remains active.

## Runtime reads and failure recovery

With `TALOS_SECRET_ROTATION_ENABLED=true`, `Settings.secret_value(name)` resolves
the active encrypted value at the moment a credential is used. API
authorization headers are built per request, LLM credentials are resolved per
agent cycle, and channel adapters resolve credentials per operation.

Reads try:

1. the active encrypted version;
2. the previous non-revoked version when dual-read is enabled;
3. the legacy Settings/environment value when legacy fallback is enabled.

Authentication failure is not automatically treated as a decryption failure:
provider-specific retry with an old credential could duplicate a write.
Operators validate before activation and explicitly recover when a newly
activated credential is rejected. Network retries retain the credential
selected for that individual request.

Missing keys, corrupt ciphertext, lock timeouts, and transition conflicts have
typed errors and structured events. Logs expose only scope, secret name,
version, transition, outcome, and error class. They never include ciphertext,
plaintext, key IDs, authorization headers, or user payloads.

Operational signal names:

- `secret_rotation_transition`: `stage`, `activated`, `recovered`, or `revoke`
  with `success`/`failure`.
- `secret_resolution`: an active-version decrypt failed and the resolver moved
  to the previous or legacy source.
- `secret_consumer_reloaded`: the long-lived browser/provider client swapped to
  a new credential.
- `secret_consumer_reload_failed`: replacement initialization failed; the old
  browser remains live and the next cycle retries.

On restart there is no reconciliation guesswork: the committed `secret_heads`
row is authoritative. An interrupted stage is either fully committed or absent;
an interrupted activation is either fully committed or rolled back.

## Configuration and rollout

| Setting | Default | Purpose |
| --- | --- | --- |
| `TALOS_SECRET_ROTATION_ENABLED` | `false` | Enables encrypted-store reads. |
| `TALOS_SECRET_KEYRING` | empty | JSON map of key ID to URL-safe base64 AES-256 key. |
| `TALOS_SECRET_ACTIVE_KEY_ID` | empty | Key used to encrypt newly staged versions. |
| `TALOS_SECRET_SCOPE` | `default` | Namespace for agents sharing a database. |
| `TALOS_SECRET_DUAL_READ` | `true` | Fall back to the previous encrypted version. |
| `TALOS_SECRET_LEGACY_FALLBACK` | `true` | Fall back to existing Settings values. |
| `TALOS_SECRET_MAX_BYTES` | `65536` | Maximum accepted plaintext size (hard-capped). |
| `TALOS_SECRET_DB_TIMEOUT_MS` | `5000` | Bounded SQLite lock wait. |

Backward-compatible rollout:

1. Generate a key, configure the keyring/key ID, and leave rotation disabled.
2. Stage and activate each existing value with `talos-agent secrets rotate`.
3. Enable rotation with legacy fallback and verify audit/status output.
4. Remove plaintext values only after every required secret resolves.
5. Disable legacy fallback. Revoke the superseded versions after the provider's
   drain window.

## Recovery and rollback

For a bad active credential, run `talos-agent secrets recover NAME VERSION
--expected-version CURRENT`. Recovery is a CAS activation of a known,
non-revoked version and is safe to retry. Confirm the `recovered` audit event,
then revoke the rejected version if it will not be reused.

For a code rollback, set `TALOS_SECRET_ROTATION_ENABLED=false` and restore the
legacy environment value. This does not modify encrypted history. Do not delete
the keyring until all encrypted versions have been migrated or intentionally
abandoned.

Known limitations:

- SQLite coordinates processes that can safely share the same database file;
  it is not a multi-region secrets database.
- Provider-side credential creation/revocation is outside this component.
- In-flight operations keep the credential captured when their request began.
- Browser sessions may retain provider cookies; rotating a login password takes
  effect at the next login/reconnection.
- Python cannot guarantee immediate zeroization of immutable strings in process
  memory; plaintext is kept only for the operation that consumes it and is
  never cached by the secret store.

## Local verification

From `packages/prime-agent`:

```bash
uv sync --extra dev
uv run pytest tests/test_secret_store.py tests/test_secret_rotation_integration.py
uv run pytest
uv run ruff check src tests
```

The focused suite covers encryption/AAD tamper detection, plaintext absence,
input and audit limits, idempotent duplicate delivery, stale CAS writers,
bounded lock timeout, corrupt-active dual read, revocation, recovery, restart,
filesystem permissions, CLI redaction, and live API-header rotation.
