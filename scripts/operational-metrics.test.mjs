import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const documentPath = resolve("docs/operational-metrics.md");
let document;
try {
  document = readFileSync(documentPath, "utf8");
} catch {
  throw new Error("operational metrics document is missing");
}

const header = "| Metric | Type / unit | Source | Dimensions | Definition and operational use |";
if (!document.includes(header)) {
  throw new Error("operational metrics table header is missing or malformed");
}

const rows = [...document.matchAll(/^\| `([^`]+)` \|([^\n]+)$/gm)];
if (rows.length === 0) {
  throw new Error("operational metrics table has no definitions");
}

const names = rows.map(([, name]) => name);
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
if (duplicates.length > 0) {
  throw new Error(`duplicate operational metric: ${duplicates[0]}`);
}

const namePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(total|seconds|bytes)$/;
const malformed = names.find((name) => !namePattern.test(name));
if (malformed) {
  throw new Error(`malformed operational metric name: ${malformed}`);
}

for (const domain of [
  "ci_workflow",
  "local_stack",
  "benchmark",
  "db_transaction_retry",
  "job_events",
  "outbox_events",
  "backup_operations",
  "release_artifact_verifications",
  "secret_scan",
]) {
  if (!names.some((name) => name.startsWith(domain))) {
    throw new Error(`required operational metric domain is missing: ${domain}`);
  }
}

const sensitivePattern = /wallet|seed|passphrase|payment proof|request body|authorization|secret value/i;
const sensitiveRow = rows.find(([, name, columns]) => {
  const dimensions = columns.split("|")[2] ?? "";
  return sensitivePattern.test(`${name} ${dimensions}`);
});
if (sensitiveRow) {
  throw new Error(`sensitive data appears in operational metric definition: ${sensitiveRow[1]}`);
}

console.log("operational metrics definitions: OK");