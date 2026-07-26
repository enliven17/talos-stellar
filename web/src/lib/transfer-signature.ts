import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Domain separator for TALOS transfer authorizations.
 *
 * Changing this value is a breaking signature-format change and must be
 * accompanied by a new version rather than silently accepting both formats.
 */
export const TRANSFER_SIGNATURE_DOMAIN = "talos.transfer.v1";

/** A transfer authorization is valid for at most five minutes. */
export const MAX_TRANSFER_AUTH_LIFETIME_SECONDS = 5 * 60;

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

/*
 * Process-local replay guard. This intentionally provides the focused replay
 * protection required by this route without introducing a new persistence
 * model. Entries disappear after expiry and are scoped by agent.
 */
const consumedNonces = new Map<string, number>();

function pruneExpiredNonces(nowSeconds: number): void {
  for (const [key, expiry] of consumedNonces) {
    if (expiry <= nowSeconds) consumedNonces.delete(key);
  }
}

/**
 * Atomically (within one JavaScript process) consume a verified nonce.
 * This must be called immediately before the first transfer side effect.
 */
export function consumeTransferNonce(
  payload: Pick<TransferSignedPayload, "agent" | "nonce" | "expiry">,
  nowSeconds = Math.floor(Date.now() / 1000),
): NonceResult {
  pruneExpiredNonces(nowSeconds);

  const expiry = Number(payload.expiry);
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (expiry > nowSeconds + MAX_TRANSFER_AUTH_LIFETIME_SECONDS) {
    return { ok: false, reason: "expiry-too-far" };
  }

  const key = `${payload.agent}:${payload.nonce}`;
  if (consumedNonces.has(key)) {
    return { ok: false, reason: "replayed" };
  }

  // Map#set is synchronous, so a concurrent request cannot pass this guard in
  // this process before the current request begins its asynchronous transfer.
  consumedNonces.set(key, expiry);
  return { ok: true };
}
