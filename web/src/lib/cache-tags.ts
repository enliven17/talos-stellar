/**
 * Next.js cache tags for mutable agent (TALOS) data.
 *
 * Pages and cached loaders should subscribe via `unstable_cache(..., { tags })`.
 * Mutation routes must call `revalidateAgentTags` / `revalidateTag` so list +
 * detail surfaces drop stale payloads without a full redeploy.
 */

export const AGENTS_LIST_TAG = "agents:list";

/** Tag for one agent detail payload. */
export function agentTag(id: string): string {
  if (!id || typeof id !== "string") {
    throw new Error("agentTag: id is required");
  }
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("agentTag: id must be non-empty");
  }
  return `agents:id:${trimmed}`;
}

/** All tags that should be invalidated when agent `id` mutates. */
export function agentMutationTags(id: string): string[] {
  return [AGENTS_LIST_TAG, agentTag(id)];
}
