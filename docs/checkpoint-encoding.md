# Checkpoint Encoding — Design & Operations Guide

> Tracks issue [#291](https://github.com/enliven17/talos-stellar/issues/291).  
> Implementation: `packages/prime-agent/src/talos_agent/checkpoint.py`  
> Tests: `packages/prime-agent/tests/test_checkpoint.py`  
> Fixtures: `packages/prime-agent/tests/fixtures/checkpoints/`

---

## Overview

A **checkpoint** is a signed, versioned snapshot of an agent's runtime
state.  It can be persisted to the agent's local SQLite database and later
restored — enabling graceful restarts, auditing, and cross-process state
verification.

The encoding is **canonical and deterministic**: given the same input
values, the JSON bytes produced are identical across processes, Python
interpreter versions (3.10 – 3.12), and operating systems.

---

## Schema (version 1)

```
CheckpointEnvelope
├── meta          CheckpointMeta        identity & provenance
│   ├── agent_id         str            unique agent identifier
│   ├── created_at       str            ISO-8601 UTC timestamp
│   └── schema_version   int            always 1
│
├── state         CheckpointState       mutable runtime state
│   ├── cycle_count      int  ≥ 0       completed agent cycles
│   ├── last_task        str            last scheduled task name
│   ├── balance_usdc     float ≥ 0.0   USDC wallet balance
│   └── wallet_public_key str          Stellar public key (G…, 56 chars)
│
├── config        CheckpointConfig      configuration snapshot
│   ├── talos_id         str            Talos registry ID
│   └── api_url          str            base URL of the Talos web API
│
├── section_hashes  dict[str, str]      SHA-256 per section (hex)
│   ├── meta
│   ├── state
│   └── config
│
└── envelope_hash   str                 SHA-256 of the full envelope core (hex)
```

All section models use `extra = "forbid"` — unknown fields raise a
validation error.

---

## Canonical encoding

Canonical encoding is defined by three rules applied consistently
throughout the module:

1. **Sort keys** — `json.dumps(…, sort_keys=True)`
2. **Compact separators** — `separators=(',', ':')`  (no whitespace)
3. **ASCII escape** — `ensure_ascii=True`

The resulting UTF-8 bytes are the input to every SHA-256 computation.

```python
import json, hashlib

def canonical_bytes(obj) -> bytes:
    return json.dumps(
        obj,
        sort_keys=True,
        separators=(',', ':'),
        ensure_ascii=True,
    ).encode('utf-8')

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
```

### Section hashes

Each section is serialised independently before the envelope is assembled:

```python
section_hashes = {
    name: sha256_hex(canonical_bytes(section.model_dump(mode='json')))
    for name, section in {'meta': meta, 'state': state, 'config': config}.items()
}
```

### Envelope hash

The envelope hash covers all section data **plus** the section hashes,
but **not** the `envelope_hash` field itself (to avoid circularity):

```python
envelope_core = {
    'config':  config.model_dump(mode='json'),
    'meta':    meta.model_dump(mode='json'),
    'section_hashes': section_hashes,
    'state':   state.model_dump(mode='json'),
}
envelope_hash = sha256_hex(canonical_bytes(envelope_core))
```

Because `sort_keys=True` is in effect, field insertion order does not
affect the digest.

---

## Validation rules

`verify_checkpoint(envelope)` enforces these checks in order:

| # | Rule | Exception raised |
|---|------|-----------------|
| 1 | `schema_version == 1` | `CheckpointVersionError` |
| 2 | `agent_id` is non-empty after strip | `CheckpointValidationError` |
| 3 | `balance_usdc >= 0` | `CheckpointValidationError` |
| 4 | `created_at` not more than 60 s in the future | `CheckpointValidationError` |
| 5 | `wallet_public_key` starts with `G`, exactly 56 chars | `ValueError` (model) |
| 6 | `wallet_public_key` does not look like a secret key (S…, 56 chars) | `CheckpointValidationError` |
| 7 | Each section hash matches recomputed SHA-256 | `CheckpointHashError` |
| 8 | Envelope hash matches recomputed SHA-256 | `CheckpointHashError` |

Model-level validation (rules 1–6) runs on construction via Pydantic
`field_validator` and `model_validator`; `verify_checkpoint` re-applies
rules 1–4 for defence-in-depth before proceeding to hash checks.

### Clock skew

The maximum allowed future skew is 60 seconds
(`checkpoint.MAX_FUTURE_SKEW_SECONDS`).  Checkpoints from the past are
accepted without restriction.  Clocks that are significantly behind UTC
will accept checkpoints that appear to be in their future; ensure the
agent host NTP is synchronised.

---

## Sensitive-data handling

- **Secret keys must never appear in checkpoints.**  The validator
  explicitly rejects any value that starts with `S` and is exactly 56
  characters long in `wallet_public_key` (the Stellar secret-key format).
- `agent_id` is also screened for the same pattern as a second layer.
- Pydantic's `extra = "forbid"` on all models prevents accidental leakage
  of extra fields.
- The `payload` column in SQLite stores the full JSON; protect the database
  file with appropriate filesystem permissions (`chmod 600`).

---

## Public API

```python
from talos_agent.checkpoint import (
    build_checkpoint,       # convenience factory
    encode_checkpoint,      # low-level: Meta + State + Config → Envelope
    verify_checkpoint,      # raises on any integrity or semantic failure
    checkpoint_to_json,     # Envelope → canonical JSON string
    checkpoint_from_json,   # JSON string → Envelope (no verification)
)
```

### Typical usage

```python
from talos_agent.checkpoint import build_checkpoint, verify_checkpoint, checkpoint_to_json, checkpoint_from_json

# Create and encode
env = build_checkpoint(
    agent_id="vega-001",
    talos_id="talos-vega-001",
    api_url="https://talos-stellar.vercel.app",
    cycle_count=db.get_cycle_count(),
    last_task="post_content",
    balance_usdc=42.5,
    wallet_public_key=settings.stellar_public_key,
)

# Persist
payload = checkpoint_to_json(env)
db.save_checkpoint(
    agent_id=env.meta.agent_id,
    schema_version=env.meta.schema_version,
    envelope_hash=env.envelope_hash,
    payload=payload,
    created_at=env.meta.created_at,
)

# Restore and verify
row = db.get_latest_checkpoint("vega-001")
if row:
    restored = checkpoint_from_json(row["payload"])
    verify_checkpoint(restored)   # raises on tampering or version mismatch
```

---

## Database schema (migration 7)

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT    NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    envelope_hash   TEXT    NOT NULL UNIQUE,
    payload         TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    stored_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_agent_id ON checkpoints(agent_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_stored_at ON checkpoints(stored_at);
```

The `envelope_hash UNIQUE` constraint makes `save_checkpoint` idempotent:
inserting the same checkpoint twice is a no-op (SQLite `ON CONFLICT DO
NOTHING`).

### DB helper methods

| Method | Description |
|--------|-------------|
| `save_checkpoint(agent_id, schema_version, envelope_hash, payload, created_at)` | Persist an encoded envelope; returns row ID. |
| `get_latest_checkpoint(agent_id)` | Return the most recent checkpoint dict for an agent. |
| `list_checkpoints(agent_id, limit=20)` | List checkpoints newest-first (excludes payload column for efficiency). |
| `delete_checkpoints_before(agent_id, before_stored_at)` | Rolling retention — delete old rows; returns deleted count. |

---

## Observability

The checkpoint module is pure-function / no I/O.  Observability lives in
the call site.  Recommended structlog pattern:

```python
from talos_agent.observability import log

try:
    verify_checkpoint(env)
    log.info("checkpoint.verified", agent_id=env.meta.agent_id, envelope_hash=env.envelope_hash)
except CheckpointHashError as exc:
    log.error("checkpoint.tampered", agent_id=env.meta.agent_id, error=str(exc))
    raise
except CheckpointVersionError as exc:
    log.warning("checkpoint.version_mismatch", schema_version=env.meta.schema_version, error=str(exc))
    raise
except CheckpointValidationError as exc:
    log.warning("checkpoint.invalid", agent_id=env.meta.agent_id, error=str(exc))
    raise
```

Recommended Sentry breadcrumb levels:
- `CheckpointHashError` → `error` (potential tampering)
- `CheckpointVersionError` → `warning` (upgrade needed)
- `CheckpointValidationError` → `warning` (bad input)

---

## Migration & rollback

### Forward migration

Migration 7 is additive (new table + indexes).  It runs automatically on
`LocalDB.__init__` for any database at schema version ≤ 6.  No data is
modified; the migration is safe to run against a live agent database.

### Rollback

There is no generated down-migration.  To roll back:

1. Stop the agent.
2. Restore the SQLite database from a pre-migration backup.
3. Deploy the previous agent version.

If only the checkpoint table needs to be dropped (no other data loss):

```sql
DROP TABLE IF EXISTS checkpoints;
DROP INDEX IF EXISTS idx_checkpoints_agent_id;
DROP INDEX IF EXISTS idx_checkpoints_stored_at;
PRAGMA user_version = 6;
```

Then revert the `_MIGRATIONS` list in `db.py` to remove entry 7 before
re-running the agent.

### Retention

Use `delete_checkpoints_before` to implement rolling retention.  Example:
keep only the last 30 days of checkpoints per agent:

```python
from datetime import datetime, timedelta, timezone

cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
db.delete_checkpoints_before(agent_id, cutoff)
```

---

## Limitations

- **Schema version 1 only.**  Future versions must bump `SUPPORTED_SCHEMA_VERSION`
  and add backward-compatible read logic.  Old agents will raise
  `CheckpointVersionError` when they encounter a v2+ checkpoint.
- **No encryption.**  The payload is stored as plaintext JSON.  Sensitive
  fields (e.g. `balance_usdc`, `wallet_public_key`) are visible to anyone
  with filesystem access.  Protect the SQLite file at rest.
- **No partial-section updates.**  A checkpoint is always a full snapshot;
  there is no delta or patch encoding.
- **Clock skew is best-effort.**  The future-timestamp guard relies on the
  host clock.  An agent with a severely misconfigured clock may accept or
  reject checkpoints incorrectly.
- **Single-writer per database.**  SQLite WAL mode allows concurrent reads
  but only one writer at a time.  The checkpoint table inherits the same
  constraint; do not write checkpoints from multiple threads simultaneously.
