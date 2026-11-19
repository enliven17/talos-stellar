/**
 * Full-jitter exponential backoff for outbox dispatch retries: a random
 * value in [0, min(cap, base * 2^(attempts-1))). One class is enough here —
 * unlike job handlers (arbitrary external work), a consumer failure is
 * almost always transient (a downstream service hiccup), so there's no
 * separate "rate_limited" tier.
 */
const BASE_MS = 1_000;
const CAP_MS = 5 * 60_000;

export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.floor(random() * exp);
}

export type RetryDecision = { action: "retry"; delayMs: number } | { action: "dead_letter" };

export function decideRetry(
  input: { attempts: number; maxAttempts: number },
  random: () => number = Math.random,
): RetryDecision {
  if (input.attempts >= input.maxAttempts) return { action: "dead_letter" };
  return { action: "retry", delayMs: backoffMs(input.attempts, random) };
}
