/**
 * Privacy-safe error messaging for agent views.
 * Shared by server pages and client UI — keep free of React / "use client".
 */

const SECRETISH =
  /\b(secret|seed|mnemonic|private[_\s-]?key|api[_\s-]?key|bearer|authorization|password|passwd|token|payment[_\s-]?proof|signed[_\s-]?xdr|x-api-key)\b/i;

const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const JWTISH = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const STELLAR_SECRET = /\bS[A-Z2-7]{55}\b/g;

export type AgentViewEmptyKind =
  | "catalog"
  | "filtered"
  | "service"
  | "activity"
  | "patrons"
  | "revenue"
  | "proposals"
  | "generic";

const EMPTY_COPY: Record<
  AgentViewEmptyKind,
  { title: string; description: string }
> = {
  catalog: {
    title: "No agents yet",
    description:
      "The agent directory is empty. Check back after agents have been registered.",
  },
  filtered: {
    title: "No agents match your query",
    description:
      "Try a different search term, category, or online/offline filter.",
  },
  service: {
    title: "No commerce service",
    description: "This agent does not offer a commerce service yet.",
  },
  activity: {
    title: "No activity yet",
    description: "No activity has been recorded for this agent yet.",
  },
  patrons: {
    title: "No patrons yet",
    description: "Be the first patron to support this agent.",
  },
  revenue: {
    title: "No revenue data yet",
    description: "Revenue history will appear once jobs complete.",
  },
  proposals: {
    title: "No proposals yet",
    description: "Governance proposals will show up here when submitted.",
  },
  generic: {
    title: "Nothing here yet",
    description: "There is no data to display for this view.",
  },
};

/** Strip sensitive material and collapse noisy exception text. */
export function toPrivacySafeAgentError(
  input: unknown,
  fallback = "Something went wrong loading agent data. Please try again.",
): string {
  if (input == null) return fallback;

  let raw: string;
  if (typeof input === "string") {
    raw = input;
  } else if (input instanceof Error) {
    raw = input.message || fallback;
  } else if (typeof input === "object" && "message" in (input as object)) {
    const msg = (input as { message?: unknown }).message;
    raw = typeof msg === "string" ? msg : fallback;
  } else {
    return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  if (SECRETISH.test(trimmed)) return fallback;

  let safe = trimmed
    .replace(STELLAR_SECRET, "[redacted]")
    .replace(JWTISH, "[redacted]")
    .replace(LONG_HEX, "[redacted]");

  safe = safe.split("\n")[0]?.trim() ?? fallback;
  if (safe.length > 180) {
    safe = `${safe.slice(0, 177)}...`;
  }

  if (!safe || safe === "[redacted]") return fallback;
  return safe;
}

export function emptyCopyFor(kind: AgentViewEmptyKind) {
  return EMPTY_COPY[kind] ?? EMPTY_COPY.generic;
}
