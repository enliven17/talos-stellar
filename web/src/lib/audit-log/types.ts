export interface AuditLogRecord {
  id: string;
  talosId: string;
  method: string;
  path: string;
  statusCode: number;
  denialReason: string | null;
  scopesRequired: string[] | null;
  ipAddress: string | null;
  sequenceNumber: number | null;
  previousHash: string | null;
  entryHash: string | null;
  chainVersion: string | null;
  createdAt: string;
}
