-- Add keyId and keyType columns to API audit logs for structured observability.
-- These are nullable for backward compatibility with existing rows.

ALTER TABLE tls_api_audit_logs ADD COLUMN keyId text;
ALTER TABLE tls_api_audit_logs ADD COLUMN keyType text;
