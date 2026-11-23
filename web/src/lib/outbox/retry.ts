/**
 * Full-jitter exponential backoff for outbox dispatch retries: a random
 * value in [0, min(cap, base * 2^(attempts-1))). One class is enough here —
 * unlike job handlers (arbitrary external work), a consumer failure is
 * almost always transient (a downstream service hiccup), so there's no
 * separate "rate_limited" tier.
 */
const BASE_MS = 1_000;
const CAP_MS = 5 * 60_000;

export const MAX_RETRY_DELAY_MS = CAP_MS;

/**
 * Clamps a relative retry delay to a finite, non-negative, bounded integer
 * duration in milliseconds: [0, maxDelayMs].
 */
export function boundRetryDelayMs(delayMs: number, maxDelayMs: number = MAX_RETRY_DELAY_MS): number {
  const safeMax = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? Math.floor(maxDelayMs) : MAX_RETRY_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  return Math.min(safeMax, Math.floor(delayMs));
}

export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempts - 1));
  return boundRetryDelayMs(random() * exp);
}

export type RetryDecision = { action: "retry"; delayMs: number } | { action: "dead_letter" };

export function decideRetry(
  input: { attempts: number; maxAttempts: number },
  random: () => number = Math.random,
): RetryDecision {
  if (input.attempts >= input.maxAttempts) return { action: "dead_letter" };
  return { action: "retry", delayMs: backoffMs(input.attempts, random) };
}
