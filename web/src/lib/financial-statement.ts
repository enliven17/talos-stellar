import { createHash } from "node:crypto";

export const FINANCIAL_STATEMENT_SCHEMA_VERSION = "1.0.0";
export const FINANCIAL_STATEMENT_SOURCE_POLICY_VERSION = "financial-statement/v1";
export const FINANCIAL_STATEMENT_MAX_ROWS = 10_000;
export const FINANCIAL_STATEMENT_CSV_HEADER =
  "timestamp,category,direction,counterparty,description,amount_usdc,status,network,bound,transaction_hash";

export type FinancialStatementCategory = "revenue" | "approval" | "distribution";
export type FinancialStatementDirection = "credit" | "debit" | "neutral";
export type FinancialStatementBound = "observed" | "unavailable";

export interface FinancialStatementEntry {
  id: string;
  timestamp: string | null;
  category: FinancialStatementCategory;
  direction: FinancialStatementDirection;
  counterparty: string | null;
  description: string;
  amountUsdc: string | null;
  status: string;
  network: string | null;
  bound: FinancialStatementBound;
  transactionHash: string | null;
}

export interface FinancialStatementTotals {
  creditsUsdc: string;
  debitsUsdc: string;
  netUsdc: string;
  unavailableEntries: number;
}

export interface OwnerFinancialStatement {
  schemaVersion: string;
  sourcePolicyVersion: string;
  generatedAt: string;
  talosId: string;
  agentName: string | null;
  network: string | null;
  observationWindow: { from: string | null; to: string | null };
  observedAt: string | null;
  entries: FinancialStatementEntry[];
  totals: FinancialStatementTotals;
  limits: { truncated: boolean; maxRows: number };
  privacy: { credentialsIncluded: false; internalNotesIncluded: false };
  digest: string;
}

type StatementRow = Record<string, unknown>;

export interface FinancialStatementInput {
  talos: StatementRow;
  revenues?: StatementRow[];
  approvals?: StatementRow[];
  distributions?: StatementRow[];
  from?: string | null;
  to?: string | null;
  network?: string | null;
  generatedAt?: string | null;
  maxRows?: number;
}

const SCALE = 1_000_000n;

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function timestampValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const raw = stringValue(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseScaledAmount(value: unknown): bigint | null {
  const raw = stringValue(value);
  if (!raw || !/^[+-]?\d+(?:\.\d{1,6})?$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = raw.replace(/^[+-]/, "").split(".");
  const digits = `${whole}${fraction.padEnd(6, "0")}`;
  const scaled = BigInt(digits);
  return negative ? -scaled : scaled;
}

function formatScaledAmount(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

interface BuiltEntry {
  entry: FinancialStatementEntry;
  scaled: bigint | null;
}

function buildEntry(
  category: FinancialStatementCategory,
  row: StatementRow,
  network: string | null,
  fallbackStatus: string,
  timestampFields: string[],
  descriptionFields: string[],
): BuiltEntry {
  const scaled = parseScaledAmount(row.amount);
  const timestamp = timestampFields
    .map((field) => timestampValue(row[field]))
    .find((value) => value != null) ?? null;
  const description =
    descriptionFields.map((field) => stringValue(row[field])).find((value) => value != null) ??
    category;
  const status = stringValue(row.status);
  const direction: FinancialStatementDirection =
    category === "revenue"
      ? "credit"
      : category === "distribution" || status?.toLowerCase() === "approved"
        ? "debit"
        : "neutral";

  return {
    scaled,
    entry: {
      id: stringValue(row.id) ?? `${category}-${timestamp ?? "unknown"}`,
      timestamp,
      category,
      direction,
      counterparty: null,
      description,
      amountUsdc: scaled == null ? null : formatScaledAmount(scaled),
      status: status ?? fallbackStatus,
      network,
      bound: scaled == null ? "unavailable" : "observed",
      transactionHash: stringValue(row.txHash),
    },
  };
}

export function buildOwnerFinancialStatement(input: FinancialStatementInput): OwnerFinancialStatement {
  const network = stringValue(input.network);
  const generatedAt = timestampValue(input.generatedAt) ?? new Date().toISOString();
  const maxRows = input.maxRows ?? FINANCIAL_STATEMENT_MAX_ROWS;

  const built: BuiltEntry[] = [
    ...(input.revenues ?? []).map((row) =>
      buildEntry("revenue", row, network, "recorded", ["createdAt"], ["source", "title"]),
    ),
    ...(input.approvals ?? []).map((row) =>
      buildEntry("approval", row, network, "unknown", ["decidedAt", "updatedAt", "createdAt"], [
        "title",
        "type",
      ]),
    ),
    ...(input.distributions ?? []).map((row) =>
      buildEntry("distribution", row, network, "recorded", ["createdAt"], ["title", "type"]),
    ),
  ];

  const ordered = built
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.entry.timestamp;
      const right = b.item.entry.timestamp;
      if (left == null && right != null) return 1;
      if (left != null && right == null) return -1;
      if (left != null && right != null && left !== right) return left.localeCompare(right);
      return a.index - b.index;
    })
    .map(({ item }) => item);

  let credits = 0n;
  let debits = 0n;
  let unavailableEntries = 0;
  for (const { entry, scaled } of ordered) {
    if (scaled == null) {
      unavailableEntries += 1;
      continue;
    }
    if (entry.direction === "credit") credits += scaled;
    if (entry.direction === "debit") debits += scaled;
  }

  const statement = {
    schemaVersion: FINANCIAL_STATEMENT_SCHEMA_VERSION,
    sourcePolicyVersion: FINANCIAL_STATEMENT_SOURCE_POLICY_VERSION,
    generatedAt,
    talosId: stringValue(input.talos.id) ?? "unknown",
    agentName: stringValue(input.talos.agentName) ?? stringValue(input.talos.name),
    network,
    observationWindow: {
      from: timestampValue(input.from),
      to: timestampValue(input.to),
    },
    observedAt: timestampValue(input.talos.observedAt),
    entries: ordered.slice(0, Math.max(0, maxRows)).map(({ entry }) => entry),
    totals: {
      creditsUsdc: formatScaledAmount(credits),
      debitsUsdc: formatScaledAmount(debits),
      netUsdc: formatScaledAmount(credits - debits),
      unavailableEntries,
    },
    limits: { truncated: ordered.length > maxRows, maxRows },
    privacy: {
      credentialsIncluded: false as const,
      internalNotesIncluded: false as const,
    },
  };

  const digest = createHash("sha256").update(JSON.stringify(statement)).digest("hex");
  return { ...statement, digest: `sha256:${digest}` };
}

function escapeCsvCell(value: string | null): string {
  const raw = value ?? "";
  const guarded = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function financialStatementToCsv(statement: OwnerFinancialStatement): string {
  const lines = [FINANCIAL_STATEMENT_CSV_HEADER];
  for (const entry of statement.entries) {
    lines.push(
      [
        entry.timestamp,
        entry.category,
        entry.direction,
        entry.counterparty,
        entry.description,
        entry.amountUsdc,
        entry.status,
        entry.network,
        entry.bound,
        entry.transactionHash,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
