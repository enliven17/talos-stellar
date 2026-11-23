import { createHash } from "node:crypto";
import {
  AUDIT_REDACTION_POLICY_VERSION,
  redactPayload,
} from "./redact";
import {
  verifyChain,
  type ChainVerificationResult,
} from "./audit-chain";
import type { AuditLogRecord } from "./audit-log/types";

export const AUDIT_EXPORT_FORMAT = "talos.audit.export";
export const AUDIT_EXPORT_VERSION = "1";
export { AUDIT_REDACTION_POLICY_VERSION } from "./redact";

export type AuditExportRecord = AuditLogRecord & {
  /** The rules that produced the redacted values in this record. */
  redactionPolicyVersion: string;
};

export interface AuditExport {
  format: typeof AUDIT_EXPORT_FORMAT;
  formatVersion: typeof AUDIT_EXPORT_VERSION;
  redactionPolicyVersion: string;
  exportedAt: string;
  records: AuditExportRecord[];
  integrityHash: string;
}

export type AuditExportFailure =
  | "policy_version_mismatch"
  | "data_corruption";

export interface AuditExportVerification {
  valid: boolean;
  failure: AuditExportFailure | null;
  expectedPolicyVersion: string;
  actualPolicyVersion: string | null;
  chain: ChainVerificationResult | null;
}

/**
 * Canonical bytes for the export envelope, excluding its self-authenticating
 * integrityHash. Property order is fixed so the same records and timestamp
 * always produce the same digest on every runtime.
 */
export function canonicalizeAuditExport(
  exportData: Omit<AuditExport, "integrityHash">,
): string {
  return JSON.stringify({
    format: exportData.format,
    formatVersion: exportData.formatVersion,
    redactionPolicyVersion: exportData.redactionPolicyVersion,
    exportedAt: exportData.exportedAt,
    records: exportData.records.map((record) => ({
      id: record.id,
      talosId: record.talosId,
      method: record.method,
      path: record.path,
      statusCode: record.statusCode,
      denialReason: record.denialReason,
      scopesRequired: record.scopesRequired,
      ipAddress: record.ipAddress,
      sequenceNumber: record.sequenceNumber,
      previousHash: record.previousHash,
      entryHash: record.entryHash,
      chainVersion: record.chainVersion,
      createdAt: record.createdAt,
      redactionPolicyVersion: record.redactionPolicyVersion,
    })),
  });
}

export function computeAuditExportHash(
  exportData: Omit<AuditExport, "integrityHash">,
): string {
  return createHash("sha256")
    .update(`talos.audit.export.v1:${canonicalizeAuditExport(exportData)}`, "utf8")
    .digest("hex");
}

/** Create a deterministic, self-describing export from already stored rows. */
export function createAuditExport(
  records: readonly AuditLogRecord[],
  exportedAt: string,
  policyVersion = AUDIT_REDACTION_POLICY_VERSION,
): AuditExport {
  const exportedRecords = records.map((record) => ({
    ...redactPayload(record),
    redactionPolicyVersion: policyVersion,
  })) as AuditExportRecord[];

  const unsigned = {
    format: AUDIT_EXPORT_FORMAT as typeof AUDIT_EXPORT_FORMAT,
    formatVersion: AUDIT_EXPORT_VERSION as typeof AUDIT_EXPORT_VERSION,
    redactionPolicyVersion: policyVersion,
    exportedAt,
    records: exportedRecords,
  };

  return { ...unsigned, integrityHash: computeAuditExportHash(unsigned) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Verify an export without a database or network connection.
 * Policy mismatches are reported before digest/chain failures so a verifier
 * can distinguish a changed redaction contract from modified records.
 */
export function verifyAuditExport(
  value: unknown,
  expectedPolicyVersion = AUDIT_REDACTION_POLICY_VERSION,
): AuditExportVerification {
  const actualPolicyVersion =
    isObject(value) && typeof value.redactionPolicyVersion === "string"
      ? value.redactionPolicyVersion
      : null;
  const records = isObject(value) && Array.isArray(value.records) ? value.records : [];

  if (actualPolicyVersion !== expectedPolicyVersion) {
    return {
      valid: false,
      failure: "policy_version_mismatch",
      expectedPolicyVersion,
      actualPolicyVersion,
      chain: null,
    };
  }

  if (
    records.some(
      (record) =>
        isObject(record) &&
        typeof record.redactionPolicyVersion === "string" &&
        record.redactionPolicyVersion !== expectedPolicyVersion,
    )
  ) {
    return {
      valid: false,
      failure: "policy_version_mismatch",
      expectedPolicyVersion,
      actualPolicyVersion,
      chain: null,
    };
  }

  if (
    !isObject(value) ||
    value.format !== AUDIT_EXPORT_FORMAT ||
    value.formatVersion !== AUDIT_EXPORT_VERSION ||
    typeof value.exportedAt !== "string" ||
    typeof value.integrityHash !== "string" ||
    records.some(
      (record) =>
        !isObject(record) ||
        record.redactionPolicyVersion !== expectedPolicyVersion,
    )
  ) {
    return {
      valid: false,
      failure: "data_corruption",
      expectedPolicyVersion,
      actualPolicyVersion,
      chain: null,
    };
  }

  const unsigned = { ...value } as Omit<AuditExport, "integrityHash">;
  delete (unsigned as Partial<AuditExport>).integrityHash;
  if (computeAuditExportHash(unsigned) !== value.integrityHash) {
    return {
      valid: false,
      failure: "data_corruption",
      expectedPolicyVersion,
      actualPolicyVersion,
      chain: null,
    };
  }

  let chain: ChainVerificationResult;
  try {
    chain = verifyChain(
      records.map((record) => ({
        sequenceNumber: typeof record.sequenceNumber === "number" ? record.sequenceNumber : null,
        entryHash: typeof record.entryHash === "string" ? record.entryHash : null,
        previousHash: typeof record.previousHash === "string" ? record.previousHash : null,
        chainVersion: typeof record.chainVersion === "string" ? record.chainVersion : null,
        talosId: String(record.talosId),
        method: String(record.method),
        path: String(record.path),
        statusCode: Number(record.statusCode),
        ipAddress: typeof record.ipAddress === "string" ? record.ipAddress : null,
        createdAt: new Date(String(record.createdAt)),
      })),
    );
  } catch {
    return {
      valid: false,
      failure: "data_corruption",
      expectedPolicyVersion,
      actualPolicyVersion,
      chain: null,
    };
  }

  return {
    valid: chain.valid,
    failure: chain.valid ? null : "data_corruption",
    expectedPolicyVersion,
    actualPolicyVersion,
    chain,
  };
}
