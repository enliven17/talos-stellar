# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |
| `GET` | `/api/talos/:id/audit/verify` | `Authorization: Bearer <AGENT_API_KEY>` |

UI: `/admin/audit` (stores the admin key in `sessionStorage` only).

## Hash-chain range verification

`verifyChainRange(rows, options)` in `src/lib/audit-chain.ts` and `verifyAuditChainRange(filter)` in `src/lib/audit-log/store.ts` verify the tamper-evident audit hash chain over a selected `[from, to]` time window:

- **Predecessor boundary**: When `from` is provided, the immediate chained predecessor before `from` is loaded and checked against the first record in the window (`sequenceNumber === predecessor.sequenceNumber + 1` and `previousHash === predecessor.entryHash`). If the window starts at genesis (`sequenceNumber === 0`), `previousHash` must be `GENESIS`.
- **Ordered records**: Entries in the window must have non-decreasing timestamps within `[from, to]` and strictly contiguous sequence numbers (`+1` with no gaps).
- **Incomplete range vs. broken chain**:
  - `status: "valid"` (`valid: true`, `complete: true`): All records and the predecessor boundary are intact and complete.
  - `status: "incomplete"` (`valid: false`, `complete: false`, `incompleteReason: "missing_predecessor" | "truncated_range" | "out_of_order_records"`): The window starts after sequence `0` without predecessor context, or was truncated by `limit`, while all verified internal links are untampered (`brokenAtSequence: null`).
  - `status: "broken"` (`valid: false`, `complete: false`, `failureReason: "predecessor_mismatch" | "unexpected_genesis" | "sequence_gap" | "previous_hash_mismatch" | "entry_hash_mismatch" | "out_of_order_records"`): A cryptographic hash mismatch, sequence gap, predecessor mismatch, or out-of-order record was detected at `brokenAtSequence`.

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
