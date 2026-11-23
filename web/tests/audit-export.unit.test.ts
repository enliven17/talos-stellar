import { describe, expect, it } from "vitest";
import {
  AUDIT_EXPORT_FORMAT,
  AUDIT_REDACTION_POLICY_VERSION,
  computeAuditExportHash,
  createAuditExport,
  verifyAuditExport,
} from "../src/lib/audit-export";
import { AUDIT_CHAIN_VERSION, computeEntryHash, GENESIS_HASH } from "../src/lib/audit-chain";
import type { AuditLogRecord } from "../src/lib/audit-log/types";

function record(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  const base = {
    id: "log-1",
    talosId: "talos-1",
    method: "GET",
    path: "/api/talos/talos-1/status",
    statusCode: 200,
    denialReason: null,
    scopesRequired: null,
    ipAddress: "127.0.0.1",
    sequenceNumber: 0,
    previousHash: GENESIS_HASH,
    entryHash: null,
    chainVersion: AUDIT_CHAIN_VERSION,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies AuditLogRecord;

  return {
    ...base,
    entryHash: computeEntryHash({
      sequenceNumber: base.sequenceNumber!,
      talosId: base.talosId,
      method: base.method,
      path: base.path,
      statusCode: base.statusCode,
      ipAddress: base.ipAddress,
      createdAt: base.createdAt,
    }),
  };
}

describe("audit export", () => {
  it("binds every exported record to a stable redaction policy", () => {
    const exported = createAuditExport([record()], "2026-01-02T00:00:00.000Z");

    expect(exported.format).toBe(AUDIT_EXPORT_FORMAT);
    expect(exported.redactionPolicyVersion).toBe(AUDIT_REDACTION_POLICY_VERSION);
    expect(exported.records[0].redactionPolicyVersion).toBe(
      AUDIT_REDACTION_POLICY_VERSION,
    );
    expect(verifyAuditExport(exported)).toMatchObject({ valid: true, failure: null });
  });

  it("reports a policy change separately from modified data", () => {
    const exported = createAuditExport([record()], "2026-01-02T00:00:00.000Z");
    const policyChanged = { ...exported, redactionPolicyVersion: "talos.audit.redaction.v2" };
    const dataChanged = { ...exported, records: [{ ...exported.records[0], path: "/tampered" }] };

    expect(verifyAuditExport(policyChanged).failure).toBe("policy_version_mismatch");
    expect(verifyAuditExport(dataChanged).failure).toBe("data_corruption");
  });

  it("uses stable bytes when the export inputs are unchanged", () => {
    const exported = createAuditExport([record()], "2026-01-02T00:00:00.000Z");
    const { integrityHash: _integrityHash, ...unsigned } = exported;
    expect(computeAuditExportHash(unsigned)).toBe(exported.integrityHash);
  });
});
