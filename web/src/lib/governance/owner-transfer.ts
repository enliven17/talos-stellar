/**
 * Owner transfer preview — pure, I/O-free module.
 *
 * Before executing an ownership transfer the caller may request a preview
 * that shows exactly which permissions and obligations would be affected,
 * without committing any change.  This module defines the preview type and
 * its builder so the logic can be tested without a database.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface OwnerTransferPreview {
  /** ID of the agent whose ownership is being transferred. */
  agentId: string;
  /** Current owner Stellar G-address (creatorPublicKey). */
  currentOwner: string | null;
  /** Permissions held by the current owner that will transfer to the new owner. */
  affectedPermissions: string[];
  /**
   * Outstanding obligations the new owner inherits.
   * These do not block the transfer but are surfaced so both parties are aware.
   */
  pendingObligations: {
    /** Jobs in a non-terminal state at preview time. */
    pendingJobs: number;
    /** Revenue not yet distributed to patrons. */
    undistributedRevenueUSDC: number;
    /** Active patron count (token holders affected by the ownership change). */
    activePatronCount: number;
  };
  /** ISO timestamp of when the preview was generated. */
  previewedAt: string;
}

export interface OwnerTransferPreviewInput {
  agentId: string;
  currentOwner: string | null;
  grantedPermissions: readonly string[];
  pendingJobs: number;
  undistributedRevenueUSDC: number;
  activePatronCount: number;
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build an {@link OwnerTransferPreview} from pre-fetched agent state.
 * No mutations; safe to call on every GET.
 */
export function buildOwnerTransferPreview(
  input: OwnerTransferPreviewInput,
  now: Date = new Date(),
): OwnerTransferPreview {
  return {
    agentId: input.agentId,
    currentOwner: input.currentOwner,
    affectedPermissions: [...input.grantedPermissions],
    pendingObligations: {
      pendingJobs: input.pendingJobs,
      undistributedRevenueUSDC: input.undistributedRevenueUSDC,
      activePatronCount: input.activePatronCount,
    },
    previewedAt: now.toISOString(),
  };
}
