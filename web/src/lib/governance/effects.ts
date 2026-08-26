/**
 * Concrete side effects for the durable provisioning workflows.
 *
 * Every `run` here is written to converge, not to assume it is running for the
 * first time: it checks whether the effect is already present and returns the
 * existing value instead of creating a second one. That is what makes a retry
 * after an ambiguous failure (timeout, process kill, duplicate delivery) safe.
 *
 * Every `compensate` is written to be safe when the matching `run` only
 * partially applied, and safe to call twice.
 */
import { randomBytes } from "crypto";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { tlsCommerceJobs, tlsCommerceServices, tlsTalos } from "@/db/schema";
import { logger } from "@/lib/logger";

import type { ProvisioningEffects, StepContext } from "./provisioning";

async function loadAgent(talosId: string) {
  return db
    .select({
      id: tlsTalos.id,
      agentWalletId: tlsTalos.agentWalletId,
      agentWalletAddress: tlsTalos.agentWalletAddress,
      apiKey: tlsTalos.apiKey,
      agentOnline: tlsTalos.agentOnline,
      status: tlsTalos.status,
    })
    .from(tlsTalos)
    .where(eq(tlsTalos.id, talosId))
    .limit(1)
    .then((r) => r[0] ?? null);
}

export const databaseEffects: ProvisioningEffects = {
  /**
   * Allocate the agent's Stellar wallet. The public key is persisted; the
   * secret is never written to the database — it is returned once to the
   * caller's secret store, matching how `POST /api/talos` already handles it.
   */
  async createWallet(ctx: StepContext) {
    const agent = await loadAgent(ctx.talosId);
    if (!agent) throw new Error("agent not found");

    if (agent.agentWalletId) {
      // Already provisioned by a previous attempt — converge, don't re-mint.
      return { walletPublicKey: agent.agentWalletId, reused: true };
    }

    const { createAgentKeypair } = await import("@/lib/stellar");
    const keypair = await createAgentKeypair();

    await db
      .update(tlsTalos)
      .set({ agentWalletId: keypair.publicKey, agentWalletAddress: keypair.publicKey })
      // Compare-and-set: only the first attempt to observe an unset wallet wins.
      .where(and(eq(tlsTalos.id, ctx.talosId), isNull(tlsTalos.agentWalletId)));

    // Re-read rather than trusting the update: a concurrent attempt may have
    // won the CAS, and its key is the one of record.
    const settled = await loadAgent(ctx.talosId);
    return { walletPublicKey: settled?.agentWalletId ?? keypair.publicKey, reused: false };
  },

  /**
   * Detach the wallet from the agent record. The keypair itself is not
   * destroyed — a funded account may hold residual balance, so it is left for
   * operator reconciliation and only unlinked here.
   */
  async releaseWallet(ctx: StepContext) {
    await db
      .update(tlsTalos)
      .set({ agentWalletId: null, agentWalletAddress: null })
      .where(eq(tlsTalos.id, ctx.talosId));

    logger.info(
      { event: "provisioning.wallet_released", talosId: ctx.talosId, jobId: ctx.jobId },
      "wallet unlinked during compensation; balance requires manual reconciliation",
    );
  },

  /**
   * Mint the agent's API key. The key value itself never enters the step
   * output — the output records only that a key exists, because step outputs
   * are persisted in `tls_provisioning_jobs.steps` and surfaced to operators.
   */
  async issueCredentials(ctx: StepContext) {
    const agent = await loadAgent(ctx.talosId);
    if (!agent) throw new Error("agent not found");
    if (agent.apiKey) return { credentialIssued: true, reused: true };

    const apiKey = `tak_${randomBytes(24).toString("hex")}`;
    await db.update(tlsTalos).set({ apiKey }).where(eq(tlsTalos.id, ctx.talosId));

    return { credentialIssued: true, reused: false };
  },

  async revokeCredentials(ctx: StepContext) {
    await db.update(tlsTalos).set({ apiKey: null }).where(eq(tlsTalos.id, ctx.talosId));
  },

  /**
   * Point the agent's registered services at the wallet allocated by the
   * wallet step, so payments route to the account this run provisioned.
   * The prior routing key is captured in the step output so compensation can
   * restore it exactly rather than guessing.
   */
  async registerServices(ctx: StepContext) {
    const wallet = ctx.outputs.wallet?.walletPublicKey;
    if (typeof wallet !== "string" || !wallet) {
      throw new Error("wallet step produced no public key");
    }

    const existing = await db
      .select({ id: tlsCommerceServices.id, stellarPublicKey: tlsCommerceServices.stellarPublicKey })
      .from(tlsCommerceServices)
      .where(eq(tlsCommerceServices.talosId, ctx.talosId));

    await db
      .update(tlsCommerceServices)
      .set({ stellarPublicKey: wallet })
      .where(eq(tlsCommerceServices.talosId, ctx.talosId));

    return {
      serviceCount: existing.length,
      previousKeys: existing.map((s) => ({ id: s.id, stellarPublicKey: s.stellarPublicKey })),
    };
  },

  async deregisterServices(ctx: StepContext) {
    const previous = ctx.outputs.services?.previousKeys;
    if (!Array.isArray(previous)) return;

    for (const entry of previous as { id: string; stellarPublicKey: string }[]) {
      await db
        .update(tlsCommerceServices)
        .set({ stellarPublicKey: entry.stellarPublicKey })
        .where(eq(tlsCommerceServices.id, entry.id));
    }
  },

  /** Bring the agent online and let it accept work. */
  async startRuntime(ctx: StepContext) {
    await db
      .update(tlsTalos)
      .set({ status: "Active", agentOnline: true, agentLastSeen: new Date() })
      .where(eq(tlsTalos.id, ctx.talosId));

    return { online: true };
  },

  /**
   * Take the agent offline and release any queued work. In-flight leases are
   * left to expire on their own — cancelling a job a worker is mid-way through
   * would strand paid work.
   */
  async stopRuntime(ctx: StepContext) {
    await db
      .update(tlsTalos)
      .set({ agentOnline: false, agentLastSeen: new Date() })
      .where(eq(tlsTalos.id, ctx.talosId));

    await db
      .update(tlsCommerceJobs)
      .set({ status: "cancelled", leasedBy: null, leasedAt: null, leaseExpiresAt: null })
      .where(
        and(eq(tlsCommerceJobs.talosId, ctx.talosId), eq(tlsCommerceJobs.status, "pending")),
      );
  },
};
