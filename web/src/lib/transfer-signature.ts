import { createHmac, timingSafeEqual } from "node:crypto";
import { lt } from "drizzle-orm";
import { db } from "@/db";
import { tlsConsumedNonces } from "@/db/schema";

/**
 * Domain separator for TALOS transfer authorizations.
 *
 * Changing this value is a breaking signature-format change and must be
 * accompanied by a new version rather than silently accepting both formats.
 */
export const TRANSFER_SIGNATURE_DOMAIN = "talos.transfer.v1";

/** A transfer authorization is valid for at most five minutes. */
export const MAX_TRANSFER_AUTH_LIFETIME_SECONDS = 5 * 60;

/**
 * Retention window for consumed-nonce rows after their original auth expiry.
 *
 * Rows are kept for at least this long past `expiry` so that a delayed replay
 * (e.g. a retry that arrives moments after the window closed) is still caught.
 * The vacuum/prune query uses this constant:
 *
 *   DELETE FROM tls_consumed_nonces
 *   WHERE expiry < EXTRACT(EPOCH FROM NOW()) - $NONCE_RETENTION_SECONDS;
 */
export const NONCE_RETENTION_SECONDS = 3600; // 1 hour

export interface TransferSignedPayload {
  agent: string;
  destination: string;
  asset: string;
  amount: string;
  nonce: string;
  expiry: string;
}

/**
 * Serialize a transfer authorization into the one and only signed form.
 *
 * Every value has already passed the strict transfer request schema. Keeping a
 * fixed property order and a protocol-specific domain separator prevents a
 * signature from being interpreted as another action or payload shape.
 */
export function canonicalizeTransferPayload(
  payload: TransferSignedPayload,
): string {
  return `${TRANSFER_SIGNATURE_DOMAIN}:${JSON.stringify({
    agent: payload.agent,
    destination: payload.destination,
    asset: payload.asset,
    amount: payload.amount,
    nonce: payload.nonce,
    expiry: payload.expiry,
  })}`;
}

/**
 * Produce the detached request signature used by transfer API clients.
 *
 * The agent API key is already a shared secret between the agent and Web, so
 * HMAC-SHA256 authenticates the canonical request without exposing the
 * server-held Stellar secret key. The lowercase hexadecimal representation is
 * the only accepted signature encoding.
 */
export function signTransferPayload(
  payload: TransferSignedPayload,
  agentApiKey: string,
): string {
  return createHmac("sha256", agentApiKey)
    .update(canonicalizeTransferPayload(payload), "utf8")
    .digest("hex");
}

/** Verify a detached transfer signature in constant time. */
export function verifyTransferSignature(
  payload: TransferSignedPayload,
  agentApiKey: string,
  signature: string,
): boolean {
  // Validate before decoding so Buffer never accepts alternate/partial hex.
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;

  const expected = Buffer.from(signTransferPayload(payload, agentApiKey), "hex");
  const provided = Buffer.from(signature, "hex");

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

type NonceResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "expiry-too-far" | "replayed" };

/**
 * Validate the nonce expiry window without side effects.
 *
 * Returns `true` when the payload's expiry is within the acceptable window:
 * not expired, and not beyond `MAX_TRANSFER_AUTH_LIFETIME_SECONDS` from now.
 */
export function validateNonceWindow(
  payload: Pick<TransferSignedPayload, "expiry">,
  nowSeconds: number,
): NonceResult {
  const expiry = Number(payload.expiry);
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (expiry > nowSeconds + MAX_TRANSFER_AUTH_LIFETIME_SECONDS) {
    return { ok: false, reason: "expiry-too-far" };
  }
  return { ok: true };
}

/**
 * Atomically consume a verified nonce via the database.
 *
 * Persists the nonce row with a UNIQUE constraint on `(talosId, nonce)`.  When
 * two concurrent requests race for the same nonce, exactly one INSERT succeeds
 * and the other fails with a unique-violation — no advisory locks required.
 *
 * This replaces the previous in-memory Map approach, providing replay
 * protection that survives process restarts and scales across replicas.
 *
 * Must be called immediately before the first money-moving side effect.
 */
export async function consumeTransferNonce(
  payload: Pick<TransferSignedPayload, "agent" | "nonce" | "expiry">,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<NonceResult> {
  // Validate the expiry window first — no need to touch the DB for stale auths.
  const windowCheck = validateNonceWindow(payload, nowSeconds);
  if (!windowCheck.ok) {
    return windowCheck;
  }

  try {
    await db.insert(tlsConsumedNonces).values({
      talosId: payload.agent,
      nonce: payload.nonce,
      expiry: Number(payload.expiry),
    });
    return { ok: true };
  } catch (err: unknown) {
    // PostgreSQL unique-violation error code 23505 — duplicate nonce detected.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: unknown }).code === "23505"
    ) {
      return { ok: false, reason: "replayed" };
    }
    throw err;
  }
}

/**
 * Prune consumed-nonce rows whose original auth window closed long ago.
 *
 * Safe to call periodically (e.g. via a maintenance request or pg_cron).
 * Removes rows where `expiry` is older than `NONCE_RETENTION_SECONDS` from now.
 */
export async function pruneExpiredNonces(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - NONCE_RETENTION_SECONDS;
  const result = await db
    .delete(tlsConsumedNonces)
    .where(lt(tlsConsumedNonces.expiry, cutoff));

  // Drizzle delete returns { rowCount } on supported dialects, else undefined.
  return (result as { rowCount?: number }).rowCount ?? 0;
}
