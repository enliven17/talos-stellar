# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |

UI: `/admin/audit` (stores the admin key in `sessionStorage` only).

## Query filters

| Param | Meaning |
|-------|---------|
| `talosId` | Exact agent id |
| `method` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` / `OPTIONS` |
| `q` | Case-insensitive substring on `path` **or** `denialReason` (wildcards escaped) |
| `statusCode` | Exact 3-digit status (mutually exclusive with `statusClass`) |
| `statusClass` | `2xx` / `3xx` / `4xx` / `5xx` |
| `denialReason` | Exact denial reason string |
| `from` / `to` | Inclusive ISO-8601 time bounds |
| `cursor` | Exclusive `createdAt` cursor (newest-first pagination) |
| `limit` | Page size (default 50, max 200) |

Malformed filters return `400` with an explicit, privacy-safe error string.
Responses contain only columns already stored on the audit table — never API
keys, request bodies, or payment proofs.

## Compatibility

Additive only. Existing `writeAuditLog` / hash-chain / jobs paths are unchanged.

## Independently Verifiable Audit Checkpoint Bundles

Bounded, cryptographically signed audit checkpoint bundles can be exported and verified offline without database connectivity or administrator credentials.

- **Export (`exportAuditCheckpointBundle` / `createAuditCheckpointBundle` / `GET /api/talos/:id/audit/checkpoint?bundle=true`)**:
  - Produces a bounded bundle (`limit` defaults to `100`, clamped to `[1, 1000]`) with explicit chain boundaries (`startSequence`, `endSequence`, `startEntryHash`, `endEntryHash`, `previousChainHash`, `startTimestamp`, `endTimestamp`, `entryCount`, `limit`, `truncated`), `chainRoot`, and `entriesDigest`.
  - Signs the canonical checkpoint payload under domain `talos.audit.checkpoint.v1` using Ed25519 (`AUDIT_CHECKPOINT_PRIVATE_KEY` / `AUDIT_CHECKPOINT_PUBLIC_KEY`) or HMAC-SHA256 (`AUDIT_HASH_CHAIN_SECRET`).
- **Offline Verification (`verifyAuditCheckpointBundle`)**:
  - Verifies bundle structure, domain separation, bounded size, boundary consistency, `entriesDigest`, per-entry SHA-256 hash chain linkage (`talos.audit.v1`), contiguous sequence numbers, `previousChainHash` anchoring, and the cryptographic signature purely in-memory without database or admin access.
