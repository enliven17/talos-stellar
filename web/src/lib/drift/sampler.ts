/**
 * Probabilistic sampling for drift validation.
 *
 * Sampling lets operators control the CPU/latency tradeoff:
 *   - sampleRate 1.0 → validate every request (highest coverage, highest cost)
 *   - sampleRate 0.1 → validate ~10% at random (low cost, still catches drift)
 *   - sampleRate 0.0 → never sample (mode "off" short-circuits before here)
 *
 * The RNG is injectable so tests can produce deterministic results without
 * global state or real randomness.
 */

import type { ResolvedDriftConfig } from "./types.js";

/**
 * Returns true if this request should be validated, based on sampleRate.
 *
 * Invariants:
 *   - sampleRate >= 1.0 → always true
 *   - sampleRate <= 0.0 → always false
 *   - otherwise → probabilistic (uniform distribution via config.random)
 */
export function shouldSample(config: ResolvedDriftConfig): boolean {
  if (config.sampleRate >= 1.0) return true;
  if (config.sampleRate <= 0.0) return false;
  return config.random() < config.sampleRate;
}
