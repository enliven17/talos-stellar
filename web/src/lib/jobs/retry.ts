import type { RetryClass } from "./types";

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "dead_letter" };

interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

const POLICIES: Record<Exclude<RetryClass, "fatal">, BackoffPolicy> = {
  // Network blips, transient DB errors, upstream 5xx: fast first retry,
  // exponential growth, capped at 5 minutes.
  transient: { baseMs: 1_000, capMs: 5 * 60_000 },
  // Upstream rate limiting: back off much more aggressively, capped at 15 minutes.
  rate_limited: { baseMs: 10_000, capMs: 15 * 60_000 },
};

/**
 * Full jitter exponential backoff (AWS-style): a random value in
 * [0, min(cap, base * 2^attempts)). Deterministic given a jitter source, so
 * tests can pin it by passing `random`.
 */
export function backoffMs(retryClass: Exclude<RetryClass, "fatal">, attempts: number, random: () => number = Math.random): number {
  const policy = POLICIES[retryClass];
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.floor(random() * exp);
}

/**
 * Decides what happens after a job handler throws.
 *
 * `attempts` is the count including the attempt that just failed. `fatal`
 * jobs never retry — they're only ever given one attempt regardless of
 * maxAttempts, since a fatal error (bad input, auth failure) won't resolve
 * itself on a later try.
 */
export function decideRetry(
  input: { retryClass: RetryClass; attempts: number; maxAttempts: number },
  random: () => number = Math.random,
): RetryDecision {
  const { retryClass, attempts, maxAttempts } = input;

  if (retryClass === "fatal") {
    return { action: "dead_letter" };
  }

  if (attempts >= maxAttempts) {
    return { action: "dead_letter" };
  }

  return { action: "retry", delayMs: backoffMs(retryClass, attempts, random) };
}
