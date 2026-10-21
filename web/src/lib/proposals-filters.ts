/**
 * Client-safe helpers for the proposals page filters (no Node-only APIs).
 * Used by both the proposals API route (validation) and proposals-client
 * (URL <-> state), so the allowed values live in exactly one place.
 */

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const PROPOSAL_TYPES = ["transaction", "strategy", "policy", "channel"] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export interface ProposalFilters {
  /** "all" or one of PROPOSAL_STATUSES */
  status: "all" | ProposalStatus;
  /** "all" or a Talos id */
  talosId: string;
  /** "all" or one of PROPOSAL_TYPES */
  type: "all" | ProposalType;
}

export const DEFAULT_PROPOSAL_FILTERS: ProposalFilters = {
  status: "all",
  talosId: "all",
  type: "all",
};

export const PROPOSALS_PAGE_SIZE = 20;

type ParamReader = { get(name: string): string | null };

/** Read filters from URL search params; unknown/garbage values fall back to "all". */
export function parseProposalFilters(params: ParamReader): ProposalFilters {
  const status = params.get("status");
  const type = params.get("type");
  const talosId = params.get("talosId");
  return {
    status: (PROPOSAL_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as ProposalStatus)
      : "all",
    type: (PROPOSAL_TYPES as readonly string[]).includes(type ?? "")
      ? (type as ProposalType)
      : "all",
    talosId: talosId && talosId.length <= 128 ? talosId : "all",
  };
}

function filterParams(filters: ProposalFilters): URLSearchParams {
  const sp = new URLSearchParams();
  if (filters.status !== "all") sp.set("status", filters.status);
  if (filters.talosId !== "all") sp.set("talosId", filters.talosId);
  if (filters.type !== "all") sp.set("type", filters.type);
  return sp;
}

/** Shareable page URL, e.g. /proposals?status=pending&type=policy */
export function buildProposalsPageUrl(filters: ProposalFilters): string {
  const qs = filterParams(filters).toString();
  return qs ? `/proposals?${qs}` : "/proposals";
}

/** API URL for one page of results. */
export function buildProposalsApiUrl(
  filters: ProposalFilters,
  cursor?: string | null,
  limit: number = PROPOSALS_PAGE_SIZE,
): string {
  const sp = filterParams(filters);
  sp.set("limit", String(limit));
  if (cursor) sp.set("cursor", cursor);
  return `/api/proposals?${sp.toString()}`;
}
