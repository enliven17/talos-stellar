import { AuditLogClient } from "./audit-client";

export const metadata = {
  title: "Admin Audit Log — Talos",
  description: "Searchable operator view of API key audit log entries",
};

export default function AdminAuditPage() {
  return <AuditLogClient />;
}
