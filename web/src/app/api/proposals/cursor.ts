import { MAX_CURSOR_LENGTH } from "@/lib/limits";

/**
 * Opaque keyset cursor for /api/proposals.
 *
 * Proposals are ordered by (createdAt DESC, id DESC). createdAt alone is not
 * unique, so the id is the tie-breaker; without it, rows sharing a timestamp
 * could be skipped or repeated across pages.
 */
export interface ProposalCursor {
  createdAt: Date;
  id: string;
}

export function encodeProposalCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

/** Returns null for anything malformed (caller should respond 400). */
export function decodeProposalCursor(raw: string): ProposalCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime()) || parsed.id.length === 0) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
