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
| `format` | Optional export attachment format (`csv` or `json`) |

Malformed filters return `400` with an explicit, privacy-safe error string.
Responses contain only columns already stored on the audit table — never API
keys, request bodies, or payment proofs.

## Audit exports and filename safety

`sanitizeAuditExportIdentifier` and `buildAuditExportFilename` in `src/lib/audit-chain.ts`, together with `exportAuditLogs` and `serializeAuditLogExport` in `src/lib/audit-log/store.ts`, enforce strict separation between export filenames and exported record content:

- **Bounded safe filenames**: Filenames are generated strictly from validated ASCII identifiers (`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, normalized to lowercase) and optional UTC timestamps (`YYYYMMDDTHHMMSSZ`), capped at `MAX_AUDIT_EXPORT_FILENAME_LENGTH` (96 characters).
- **No untrusted actor text in filenames**: Free-form query filters (`q`, `denialReason`), paths, traversal sequences (`../`), quotes, control characters, oversized identifiers, or Unicode actor text are rejected by `sanitizeAuditExportIdentifier` and never interpolated into the filename (falling back to `audit-logs-filtered.<ext>` or throwing in strict mode).
- **Unicode preserved in exported data**: Full UTF-8 / Unicode content inside `AuditLogRecord` fields (such as `path` or `denialReason`) is preserved verbatim in the serialized JSON or CSV payload (`charset=utf-8`).

## Compatibility

Additive only. Existing `writeAuditLog` / hash-chain / jobs paths are unchanged.
