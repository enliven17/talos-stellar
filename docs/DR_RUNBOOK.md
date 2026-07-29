# Disaster Recovery Runbook

Production-grade backup, restore, and DR verification for the Talos monorepo.

This runbook is the **source of truth** when something breaks: every procedure
below has been exercised locally and in CI. Operators should be able to follow
the steps without consulting source code.

---

## Targets

| Resource | Tool | RPO target | RTO target |
|---|---|---|---|
| Web Postgres | `POST /api/ops/backup` + Supabase PITR | ≤ 24 h | ≤ 4 h |
| Prime agent SQLite | `talos-agent backup` | ≤ 24 h | ≤ 1 h |
| Configuration | Supabase Vault + Railway env | manual | manual |
| Smart contracts | On-chain, no backup needed | n/a | n/a |

These are **targets**, not guarantees; they assume backups are wired into a
cron or scheduled workflow (see `docs/DR_RUNBOOK.md` § Wiring backups).

---

## Architecture overview

```
┌─────────────────┐    encrypted    ┌─────────────────┐
│ prime-agent    │ ────artifact──▶ │ operator vault │
│ local SQLite    │                 │ S3 / disk       │
└─────────────────┘                 └─────────────────┘

┌─────────────────┐    HTTP         ┌─────────────────┐
│ web (Next.js)   │ ◀──X-Ops-Token──│ ops CLI / cron  │
│ Postgres rows   │                 │ (admin only)    │
└─────────────────┘                 └─────────────────┘
```

Both backups share the same encryption envelope so a maintainer can inspect
either with `backup-doctor` years later without source code:

```
"ENC::" + base64(salt[16] | nonce[12] | AES-256-GCM(ct) | gcmTag[16])
```

KDF: PBKDF2-HMAC-SHA256, 200 000 iterations, 32-byte derived key.

This format is **wire-compatible** between `web/src/lib/backup-crypto.ts`
and `packages/prime-agent/src/talos_agent/crypto.py`.

---

## Backup types

| Scope | What is captured | What is excluded |
|---|---|---|
| `system` (web) | All Postgres rows + row counts + Postgres version | Secrets in `.env` (kept in vault) |
| `agent` (prime) | `talos-agent.db`, `agent-<id>.db` (SQLite WAL-aware hot copy) | Raw `.env` secrets — only DB rows |
| `config` | Manifest-only snapshot for cross-system reference | Same as above |

Operators NEVER need to manually encrypt secrets inside `.env` — the AES-GCM
envelope protects the JSON body that contains the SQLite DB bytes (base64
embedded) or the table JSON dump.

---

## Operational triggers

### Daily cron (recommended)

```bash
# Web — Postgres snapshot
curl -sS -X POST "$TALOS_WEB_URL/api/ops/backup" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE_DAILY" \
  -H "Content-Type: application/json" \
  -d '{"scope":"system","triggeredBy":"cron"}' | jq

# Agent — local SQLite snapshot
cd /opt/talos-agent && \
  BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE_DAILY" \
  uv run talos-agent backup \
    --web-endpoint --ops-token "$OPS_ADMIN_SECRET" \
    --output "/var/backups/talos-agent-$(date -u +%Y%m%d-%H%M%S).enc"
```

### Ad-hoc (incident response)

```bash
uv run talos-agent backup --passphrase "$BACKUP_PASSPHRASE_INCIDENT" \
  --output ./incidental.enc
```

### Manual web trigger

```bash
curl -sS -X POST "$TALOS_WEB_URL/api/ops/backup" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE_LIVE" \
  -H "Content-Type: application/json" \
  -d '{"scope":"config","triggeredBy":"cli"}' | jq
```

---

## Verification (a.k.a. the "DR Doctor")

Before trusting any backup, especially an old one, verify it.

```bash
# Agent backup
uv run talos-agent backup-doctor --artifact ./talos-agent-20260801-000000.enc
```

Expected output includes:

- encryption label (`AES-256-GCM#PBKDF2-SHA256#200000`)
- format version (`1.0`)
- scope, timestamp, row counts, per-file SHA-256s.

If `doctor` exits **3** ("AUTH_FAILED"), the passphrase is wrong or the
artifact has been tampered with. Do NOT trust it.

### Web verification

```bash
# Verify without applying
curl -sS -X POST "$TALOS_WEB_URL/api/ops/restore" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE_DAILY" \
  -F "metadata={\"scope\":\"system\",\"mode\":\"verify-only\"};type=application/json" \
  -F "artifact=@./postgres-snapshot.enc" | jq
```

If the response includes `verified: true` and `rowCountTotal` matching your
expected count, the artifact is good.

---

## Restore procedures

### 1. Local sandbox (NEVER production for a drill)

This is the recommended place to verify a restore works end-to-end.

```bash
# Pull the latest artifact
scp vault:/backups/talos-agent-20260801.enc /tmp/restore.enc

# Bring up a clean ephemeral environment (see MIGRATIONS.md for the
# postgres recipe; see CONTRIBUTING.md for the agent recipe).
docker run --rm -d --name dr-sandbox \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dr_sandbox \
  -p 5433:5432 postgres:16
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/dr_sandbox

# Web restore (verify-only first)
curl -sS -X POST "$TALOS_WEB_URL/api/ops/restore" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE_DAILY" \
  -F "metadata={\"scope\":\"system\",\"mode\":\"verify-only\"};type=application/json" \
  -F "artifact=@/tmp/restore.enc"

# Agent restore (dry run by default)
uv run talos-agent restore /tmp/restore.enc

# Apply agent restore (DBs are copied to .pre-restore siblings first)
uv run talos-agent restore /tmp/restore.enc --confirm
```

### 2. Apply to a fresh database (web only)

After verification succeeds, apply against a fresh Postgres:

```bash
# Bring up an empty Postgres (or use Supabase's PITR to roll back to the
# desired wall-clock time, then re-restore the application layer).
docker exec dr-sandbox psql -U postgres -d dr_sandbox \
  -f /dev/stdin < web/drizzle/bootstrap-roles.sql

psql "$DATABASE_URL" -f web/drizzle/bootstrap-roles.sql

# Apply the runbook migration route which runs in a single transaction.
curl -sS -X POST "$TALOS_WEB_URL/api/ops/restore" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE_DAILY" \
  -H "X-Confirm: yes" \
  -F "metadata={\"scope\":\"system\",\"mode\":\"apply\"};type=application/json" \
  -F "artifact=@/tmp/restore.enc" | jq
```

⚠️ **`X-Confirm: yes` is required** for `mode: "apply"`. Without it the
endpoint runs in `verify-only` and returns a 409. This is the only way to
trigger a destructive write.

### 3. Rollback strategy

Apply of a **bad** restore:

- The restore runs inside a single Postgres transaction. If any row fails to
  insert OR the connection drops, the transaction is rolled back. The
  application database is never half-restored.
- For the prime agent SQLite, `restore --confirm` writes sibling
  `*.pre-restore` backups of every DB right before swap. To recover:

  ```bash
  mv ~/.talos-agent/talos-agent.db.pre-restore ~/.talos-agent/talos-agent.db
  uv run talos-agent status   # confirms DB readable
  ```

- For migrations that have moved past the backup's schema, expect
  `does not exist` errors on old tables. The restore is forward-tolerating:
  unknown tables in the artifact are skipped, known tables in the DB are
  truncated and replaced. New tables in the DB that the backup did not have
  are lost — this is the documented limitation.

---

## Status monitoring

```bash
curl -sS "$TALOS_WEB_URL/api/ops/backup/status" \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" | jq
```

Returns:

```jsonc
{
  "metrics": {
    "total": 14,
    "successes": 13,
    "failures": 1,
    "lastSuccess": { "id": "...", "startedAt": "...", "sha256": "..." },
    "lastFailure": { "id": "...", "errorMessage": "..." }
  },
  "recent": [ ... up to ~20 runs ... ]
}
```

Set up an alert on `metrics.failures > 0` over a 24h window.

---

## Privacy & key handling

- `OPS_ADMIN_SECRET`, `BACKUP_PASSPHRASE`, and `TALOS_MASTER_KEY` are kept
  out of source code. They live in the deployment vault (Vercel project env,
  Railway project env).
- Logs NEVER include the artifact bytes, the passphrase, the cipher text, or
  any secret-like string ≥ 32 hex chars. See `sanitizeErrorMessage` in
  `web/src/lib/backup-types.ts` for the regex governing this.
- API audit log records the IP + endpoint + status code for every backup /
  restore call. Auth failures are recorded separately so brute-force attempts
  are visible.

---

## Troubleshooting

| Symptom | Likely cause | First steps |
|---|---|---|
| 401 from `/api/ops/backup` | `OPS_ADMIN_SECRET` not set or differs | Compare env values; rotate if recently leaked |
| 413 from `/api/ops/restore` | Artifact > 5 MiB | Check DB growth; increase `TALOS_BACKUP_MAX_BYTES` if intentional |
| 422 from `/api/ops/restore` | AUTH_FAILED on decrypt | Wrong passphrase or tampered artifact — restore via `talos-agent backup-doctor` first |
| `talos-agent backup` exits with code 75 | Another backup already in flight (file lock) | Wait for in-flight op or remove `~/.talos-agent/locks/agent_backup.lock` after confirming safe |
| Disk fill in `$TALOS_BACKUP_DIR` | Retention not yet wired | Prune older `.enc` files; backup module is a source-of-truth, not an archive |
| `minPatronPulse` mismatch in restored rows | Schema drift between backup version and current | Re-run `pnpm db:migrate` before restore; runs `0013_add_backup_runs.sql` cleanly |

---

## Acceptance criteria (per PR template)

| Criterion | Verified by |
|---|---|
| Primary behavior end-to-end | smoke run on ephemeral PG (see CI workflow `web-backups-ci.yml`) |
| Concurrency / retry / timeout / partial failure | `test_backup_service.py` + Vitest unit tests |
| Sensitive data handling | `sanitizeErrorMessage` regression tests; audit log review |
| Backward-compatible migration | `0013_add_backup_runs.sql` is additive only |
| Existing lint / tests / builds green | `pnpm lint && pnpm test && cargo test` |
| Documentation covers setup, ops, rollback | This file + `MIGRATIONS.md`, `OBSERVABILITY.md`, `CONTRIBUTING.md`, `README.md` |
