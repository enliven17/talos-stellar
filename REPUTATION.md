# Provider Reputation Scoring (Issue #306)

## Overview

The reputation system turns a provider's (TALOS agent's) observable
commerce-job history into a transparent 0–100 score with a
confidence value that consumers can combine with their own policies.

The scoring algorithm is **pure** (`web/src/lib/reputation.ts`), so it
can be unit-tested without HTTP or DB side effects. The companion API
route (`GET /api/talos/:id/reputation`) fetches jobs, runs the scoring
function, and returns the versioned result.

## Score version

`REPUTATION_SCORE_VERSION = "1.0.0"` is pinned as a string constant and
exposed on the response. Consumers should pin to a specific version and
treat any different value as a definitional break; metrics agents and
UI affordances built on the score will misbehave silently if the
underlying formula changes without coordination.

## Score composition

Inputs are aggregated into 5 sub-signals (each clamped to `[0, 1]`):

| Sub-signal            | Default weight | Description                                                      |
|-----------------------|---------------:|------------------------------------------------------------------|
| `completionRate`      |           0.35 | Successful (`completed`/`accepted`/`settled`/`fulfilled`) ÷ decided jobs |
| `onTimeRate`          |           0.15 | Jobs fulfilled within the on-time budget (default 24h)            |
| `disputeRateInverse`  |           0.10 | `1 − dispute ratio` (rejected/disputed out of completed jobs)     |
| `concentrationInverse`|           0.15 | Bounds HHI-based buyer concentration                             |
| `recencyWeightedVolume`|          0.25 | `log10(1 + decay-weighted job count)` mapped to `[0, 1]`          |

Weights are exposed on every response (`inputsTrace.weights`), and the
`inputs` object publishes each sub-signal independently. Both are
required for replay/audit.

The weighted sum is divided by the total weight (so adding a future
sub-signal with the same defaults produces an analogous score), giving a
value in `[0, 1]` that we call `baseScoreFraction`.

## Decay

Each event contributes with a weight of `0.5^(ageDays / halfLifeDays)`.
`halfLifeDays` defaults to `30`. A 90-day-old job therefore contributes
~12.5% of a fresh job's weight; a 180-day-old job ~3%. Decay is fully
deterministic given the input timestamps and `now` anchor — no `Date.now()`
is called inside the algorithm.

## Recency-weighted volume (log-scaled)

`recencyWeightedVolume = clamp01(log10(1 + Σ decay_weight) / 3)`. At
~10 fresh jobs the value is ~0.35; at ~100 fresh jobs ~0.67; at ~1000
fresh jobs ~1.0. Future-dated jobs (clock skew) are clamped to age 0
so they don't push the volume above 1 via `0.5^(negative)`.

## Counterparty concentration (sybil resistance)

Each buyer counterparty's share of decay-weighted volume is computed,
then the HHI (sum of squared shares) is fed through a soft falloff:

```
concentrationInverse = clamp01(1 − max(0, HHI − 0.25) / 0.75)
```

For 10 evenly distributed buyers: HHI = 0.01 → inverse ≈ 1.0.
For a single buyer: HHI = 1.0 → inverse = 0.0.

When the top buyer exceeds the `maxSingleBuyerShare` threshold
(default `0.5`), an additional multiplicative damping factor
`min(maxSingleBuyerShare / topShare, 1)` clamps the headline score.
The damping factor is exposed as `inputsTrace.concentrationDamping` so
consumers can reconstruct the math.

## Cold-start regime (insufficient evidence)

Confidence is treated as a hard gate. Score is published only when **all
three** of:

- ≥ `MIN_EVIDENCE_JOBS` (5) jobs
- ≥ `MIN_EVIDENCE_COUNTERPARTIES` (3) distinct requesters
- ≥ `MIN_EVIDENCE_DAYS` (14) days of activity span

When any threshold fails, the response carries `evidence: "insufficient"`,
`confidence: 0` and `score: 0` (authoritatively forced — does not rely on
sub-signal weighting), and a human-readable `summary` explaining what is
missing. **The cold-start regime is a true hard gate**: `confidence` is
exactly `0` whenever `evidence === "insufficient"`, so consumers cannot
infer ranking from partially-evidenced providers above true cold-start
agents. Cold-start providers cannot claim a headline score, even with
perfect completion, until the evidence gate is satisfied.

`confidence` itself ranges `0–1` and is mapped to a discrete
`confidenceTier`:

| Tier    | Range          |
|---------|----------------|
| low     | `<0.34`        |
| medium  | `0.34 ≤ c < 0.67` |
| high    | `≥ 0.67`       |

## Replay & reproducibility

The pure function takes `now` as an input. The route optionally
accepts `?now=<ISO>` so callers can pin replays. The response echoes
back `requestedNow` so consumers know what window was used.

**Security:** a caller-supplied `?now=` must be within ±24h of server
time. Drifts beyond that are rejected with HTTP 400 to prevent reputation
laundering (e.g. pinning `?now=2099-01-01` to keep a stale cohort of
jobs "fresh" forever). When `?now=` is supplied the response is also
served with `Cache-Control: no-store` so edge caches don't pin a
custom-`now` result globally. Without `?now=`, the cache TTL is
`max-age=60, stale-while-revalidate=300`.

Cache key for downstream stores is **(talosId, scoreVersion, dayBucket)**
when `?now` is omitted (server-side bucketing).

## Constraints (input validation)

- `now`: must be a valid Date (caller-supplied; no `Date.now()` fallback
  inside the pure function).
- `halfLifeDays`: positive finite number.
- `onTimeBudgetHours`: positive finite number.
- `maxSingleBuyerShare`: number in `(0, 1]`.
- `weights`: all components ≥ 0 and ≥ 1 positive total.
- `jobs`: ≤ 50,000 (route normally caps at 5,000).

Invalid inputs throw `InvalidReputationInputsError`, which the route
maps to HTTP 400.

## Database view

- Source: `tls_commerce_jobs` rows for the given `talosId`.
- Filtered by `createdAt >= now − windowDays` (default 365 days).
- Capped at `jobLimit` (default 5,000, max 10,000).
- Order: most recent first (DB returns recent, but the algorithm is
  insensitive to order).

`hasResult` is `true` when the agent submitted a non-empty structured
`result` payload, which is a stronger positive signal than
`status = "completed"` alone (status can be set by the server during
async fulfilment propagation).

## Configuration knobs

All tabled at the top of `web/src/lib/reputation.ts`:

```ts
export const REPUTATION_SCORE_VERSION = "1.0.0";
export const REPUTATION_HALF_LIFE_DAYS = 30;
export const ON_TIME_BUDGET_HOURS = 24;
export const MAX_SINGLE_BUYER_SHARE = 0.5;
export const MIN_EVIDENCE_JOBS = 5;
export const MIN_EVIDENCE_COUNTERPARTIES = 3;
export const MIN_EVIDENCE_DAYS = 14;
export const SUB_SIGNAL_WEIGHTS = {
  completion: 0.35,
  onTime: 0.15,
  disputeInverse: 0.1,
  concentration: 0.15,
  recencyVolume: 0.25,
};
```

Future tuning can be done by passing an override object to
`computeReputation(inputs, options)` without touching the constants.

## Observability

| Signal                       | Where                                      |
|------------------------------|--------------------------------------------|
| Score produced               | `inputs` + `score` fields in /api/talos/:id/reputation |
| Cache header                 | `X-Reputation-Version: 1.0.0`               |
| Score version pinning        | `scoreVersion` echoed on every response    |
| Cold-start explanation       | `summary` field                            |
| Concentration warning        | `summary` field + `inputsTrace.concentrationDamping` |
| Window used                  | `windowDays`, `requestedNow`, `requestedJobLimit` |
| Cache TTL                    | 60s, stale-while-revalidate=300             |

Downstream Sentry alerts should be added if `summary.indexOf("Cold-start")`
keeps tripping or `concentrationDamping < 0.5` appears for an active
provider — both are signals of either a fresh agent or a sybil
attack respectively.

## Migration / rollback

- The module is additive — no DB migration required.
- Removing the route would not affect any existing data; the algorithm
  is recomputed on demand from the source rows.
- A future `REPUTATION_SCORE_VERSION = "1.1.0"` would change the field
  to bust caches; clients should pin the version.

## Limitations

1. **Confidence gate is hard**: providers with thin evidence see `0`
   even if every job is positive. Routes consumers to wait or pull
   onboarding evidence before publishing a score.
2. **HHI uses requesterTalosId**: human participants appear as
   `human:<pubkey>`. Multiple humans can collapse into one bucket
   only if they share the same `requesterTalosId` namespace usage,
   which is uncommon but possible. Future: link to on-chain identity.
3. **Archive ordering**: scoring is insensitive to job order so
   re-fetching with a different `jobLimit` cap might shift the
   recency-weighted volume component. Mitigated by determinism —
   same `(jobs, now)` ⇒ same score.
4. **No sentiment / qualitative feedback**: the score reflects
   fulfilment dynamics only, not textual reviews. Future issue may
   mix in playbook-content metrics and approval-pass rates.
5. **Single `now` anchor**: batched / differential updates would
   need to extend the API to score over a date range.
