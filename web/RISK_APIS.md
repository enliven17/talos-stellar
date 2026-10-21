# Risk APIs

Agent risk and accounting endpoints that expose spending quotas, counterparty exposure, active risk alerts, and credit scoring for each Talos.

All four endpoints are read-only (`GET`) and share the same authentication model.

---

## Authentication

Every endpoint requires the Talos's own API key, supplied as a Bearer token:

```
Authorization: Bearer <api_key>
```

The key is validated against `tls_talos.apiKey` using a constant-time comparison.
All successful and failed authentication attempts are appended to the audit log (`tls_api_audit_logs`).

**Error responses**

| Status | Body | Cause |
|--------|------|-------|
| `401` | `{ "error": "Missing Authorization header. Use: Bearer <api_key>" }` | No `Authorization` header |
| `403` | `{ "error": "Invalid API key" }` | Key does not match |
| `404` | `{ "error": "TALOS not found" }` | `:id` not in database |
| `500` | `{ "error": "Internal server error" }` | Unhandled exception |

---

## Endpoints

### 1. Quota

```
GET /api/talos/:id/quota
```

Returns the Talos's spending quota configuration and its 30-day utilisation against the GTM budget.

#### Calculation inputs

| Source | Fields used |
|--------|-------------|
| `tls_talos` | `approvalThreshold`, `gtmBudget` |
| `tls_approvals` | `amount` where `status = 'approved'` and `createdAt >= now - 30 days` |
| `tls_approvals` | `amount` where `status = 'pending'` (all time — open liabilities) |
| `tls_revenues` | `amount` where `createdAt >= now - 30 days` (for coverage ratio) |

**GTM utilisation** = `approvedSpend30d / gtmBudget × 100` (capped at 100 %)  
**Spend coverage ratio** = `approvedSpend30d / revenue30d × 100` (omitted when `revenue30d = 0`)

#### Response

```jsonc
{
  "talosId": "clxyz123",
  "talosName": "Vega",
  "generatedAt": "2026-10-20T10:00:00.000Z",

  "quota": {
    "approvalThreshold": 10,         // Max USDC for a single transaction before patron approval
    "gtmBudget": 200,                // Monthly GTM spend ceiling (USDC)
    "singleTransactionLimitRemaining": 10  // Mirrors approvalThreshold; changes after future policy updates
  },

  "utilisation": {
    "approvedSpend30d": 145.00,      // Realised approved spend in the last 30 days (USDC)
    "pendingSpend": 18.50,           // Uncommitted approved-pending amount (USDC)
    "remainingBudget": 55.00,        // gtmBudget − approvedSpend30d (floored at 0)
    "gtmUtilisationPct": 72.50,      // Percentage of GTM budget consumed
    "approvedApprovals30d": 14,      // Count of approved approval rows in window
    "pendingApprovals": 3            // Count of currently pending approval rows
  },

  "revenue": {
    "total30d": 320.00,              // Total revenue earned in the last 30 days (USDC)
    "spendCoverageRatioPct": 45.31   // approvedSpend30d / revenue30d × 100; null if no revenue
  },

  "status": "healthy",              // "healthy" | "near_limit" | "over_budget"
  "statusMessage": "✓ Spending within quota"
}
```

**`status` thresholds**

| Value | Condition |
|-------|-----------|
| `healthy` | `gtmUtilisationPct < 80` |
| `near_limit` | `80 ≤ gtmUtilisationPct < 100` |
| `over_budget` | `gtmUtilisationPct ≥ 100` |

---

### 2. Exposure

```
GET /api/talos/:id/exposure
```

Aggregates counterparty concentration, open job exposure, revenue source concentration, and pending liabilities into a single risk snapshot.

#### Calculation inputs

| Source | Fields used |
|--------|-------------|
| `tls_commerce_jobs` | `requesterTalosId`, `amount`, `status`, `createdAt` (30-day window) |
| `tls_commerce_jobs` | `amount` where `status IN ('pending', 'processing')` — open job exposure |
| `tls_revenues` | `source`, `amount` where `createdAt >= now - 30 days` |
| `tls_approvals` | `amount` where `status = 'pending'` |
| `tls_approvals` | `amount` where `status = 'approved'` and `createdAt >= now - 90 days` |

**Exposure ratio** = `totalCounterpartyExposure30d / revenue30d × 100`

#### Response

```jsonc
{
  "talosId": "clxyz123",
  "talosName": "Vega",
  "generatedAt": "2026-10-20T10:00:00.000Z",

  "counterpartyExposure": {
    "totalExposure30d": 210.00,      // Total USDC spent by all counterparties in 30 days
    "counterpartyCount": 4,          // Distinct requester IDs in window
    "topCounterparties": [           // Top 5 by amount, descending
      {
        "counterpartyId": "clatlas456",
        "jobCount": 8,
        "totalAmount": 120.00,
        "pendingJobs": 1,
        "failedJobs": 0
      }
    ]
  },

  "openJobExposure": {
    "openJobs": 2,                   // Jobs in pending or processing state
    "totalOpenAmount": 35.00         // USDC locked in open jobs
  },

  "revenueExposure": {
    "totalRevenue30d": 280.00,
    "revenueConcentrationPct": 64.29, // Largest single source / total × 100
    "sourceCount": 3,
    "sources": [
      { "source": "x402-payment", "total": 180.00, "transactions": 12 },
      { "source": "playbook-sale", "total": 70.00,  "transactions": 5 },
      { "source": "direct",       "total": 30.00,  "transactions": 2 }
    ]
  },

  "liabilityExposure": {
    "pendingApprovals": 3,           // Open approval requests (not yet decided)
    "pendingAmount": 28.00,          // USDC value of those requests
    "approvedSpend90d": 430.00       // Rolling 90-day approved spending reference
  },

  "riskTier": "medium",             // "low" | "medium" | "high"
  "exposureRatioPct": 75.00,
  "riskMessage": "⚠ Moderate exposure — monitor counterparty concentration"
}
```

**`riskTier` thresholds**

| Value | Condition |
|-------|-----------|
| `low` | `exposureRatioPct ≤ 75` |
| `medium` | `75 < exposureRatioPct ≤ 150` |
| `high` | `exposureRatioPct > 150` |

---

### 3. Exposure Alerts

```
GET /api/talos/:id/exposure/alerts
```

Returns the set of currently active risk alerts derived from the same data sources as the Exposure endpoint. Alerts are recalculated on every request — there is no persistent alert store.

#### Alert codes

| Code | Severity | Trigger condition |
|------|----------|-------------------|
| `BUDGET_EXHAUSTED` | `critical` | `gtmUtilisationPct ≥ 100` |
| `BUDGET_NEAR_LIMIT` | `warning` | `80 ≤ gtmUtilisationPct < 100` |
| `STALE_OPEN_JOBS` | `warning` | Any commerce job in `pending` for > 7 days |
| `HIGH_JOB_FAILURE_RATE` | `warning` / `critical` | > 5 failed jobs in 30 days; `critical` when > 20 |
| `REVENUE_DROP` | `warning` | 7-day revenue < 50 % of the 30-day weekly average |
| `REVENUE_CONCENTRATION` | `info` | Single revenue source > 80 % of 30-day total |
| `HIGH_PENDING_LIABILITIES` | `info` | Pending approval amount > 50 % of GTM budget |

#### Response

```jsonc
{
  "talosId": "clxyz123",
  "talosName": "Vega",
  "generatedAt": "2026-10-20T10:00:00.000Z",
  "alertCount": 2,
  "criticalCount": 0,
  "warningCount": 2,
  "infoCount": 0,
  "alerts": [
    {
      "id": "budget_near_limit",
      "severity": "warning",
      "code": "BUDGET_NEAR_LIMIT",
      "title": "Approaching GTM budget limit",
      "message": "85.0 % of the GTM budget consumed in the last 30 days.",
      "value": 85.0,
      "threshold": 80
    },
    {
      "id": "stale_jobs",
      "severity": "warning",
      "code": "STALE_OPEN_JOBS",
      "title": "Stale open commerce jobs",
      "message": "1 job(s) have been pending for more than 7 days, totalling 12.50 USDC.",
      "value": 1
    }
  ]
}
```

**Alert object fields**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Stable identifier for this alert type |
| `severity` | `"critical" \| "warning" \| "info"` | Risk level |
| `code` | `string` | Machine-readable code (see table above) |
| `title` | `string` | Short human-readable title |
| `message` | `string` | Full description with current metric values |
| `value` | `number?` | Current metric value that triggered the alert |
| `threshold` | `number?` | The limit the metric crossed |

Zero alerts returns `alertCount: 0` with an empty `alerts` array — not a `404`.

---

### 4. Credit Score

```
GET /api/talos/:id/credit-score
```

Computes a composite credit score (0–100) and a letter grade based on revenue stability, debt-to-revenue ratio, and patron engagement. No authentication required — this endpoint is public read-only.

#### Calculation inputs

| Source | Window | Fields used |
|--------|--------|-------------|
| `tls_revenues` | 7 / 30 / 90 days | `amount`, `count(*)` |
| `tls_approvals` | 7 / 30 / 90 days | `amount` where `status = 'approved'` |
| `tls_patrons` | All time | `count(*)`, `pulseAmount` where `status = 'active'` |

**Score components (0–100 base: 50)**

| Factor | Max points | Description |
|--------|-----------|-------------|
| Revenue factor | +30 | Activity rate = `transactionCount30d / 30 × 100`; scaled to 30 pts |
| Debt-to-revenue factor | +40 | `(1 − debtToRevenue30dPct / 100) × 40`; penalises high debt ratios |
| Patron engagement | +10 | 1 point per active patron, up to 10 |
| Positive cash flow bonus | +5 | Applied when `netWeeklyIncome > 0` |

**Credit grades**

| Grade | Minimum score |
|-------|---------------|
| A | 85 |
| B | 75 |
| C | 65 |
| D | 50 |
| F | < 50 |

#### Response

```jsonc
{
  "talosId": "clxyz123",
  "talosName": "Vega",
  "generatedAt": "2026-10-20T10:00:00.000Z",

  "creditScore": 78.40,
  "creditGrade": "B",
  "creditSummary": "B rating — Good financial health",

  "income": {
    "weeklyRevenue": 45.00,
    "monthlyRevenue": 180.00,
    "quarterlyRevenue": 510.00,
    "netWeeklyIncome": 38.50,
    "annualizedWeeklyIncome": 2002.00,
    "revenueTransactionCount": {
      "weekly": 3,
      "monthly": 12,
      "quarterly": 34
    }
  },

  "debt": {
    "weeklyApprovedSpending": 6.50,
    "monthlyApprovedSpending": 24.00,
    "quarterlyApprovedSpending": 68.00,
    "avgMonthlySpending": 24.00,
    "spendingTransactionCount": {
      "weekly": 1,
      "monthly": 4,
      "quarterly": 11
    }
  },

  "ratios": {
    "debtToRevenue7d": 14.44,        // weeklyApprovedSpending / weeklyRevenue × 100
    "debtToRevenue30d": 13.33,
    "debtToRevenue90d": 13.33
  },

  "borrowingCapacity": {
    "sustainableBorrowingLimit": 108.00,   // monthlyRevenue30d × 0.6
    "currentMonthlySpending": 24.00,
    "borrowingUtilization": 22.22,
    "borrowingStatusMessage": "✓ Healthy borrowing level"
  },

  "patronEngagement": {
    "activePatrons": 3,
    "totalPatronHoldings": 300000
  },

  "riskFactors": [],                 // Non-empty strings; filtered falsy values removed

  "recommendations": [
    "Increase transaction frequency for stability"
  ]
}
```

**`borrowingStatusMessage` thresholds**

| Message | Condition |
|---------|-----------|
| `✓ Healthy borrowing level` | `borrowingUtilization ≤ 75` |
| `⚠ High utilization — monitor closely` | `75 < borrowingUtilization ≤ 100` |
| `⚠ Over sustainable limit — reduce spending or increase revenue` | `borrowingUtilization > 100` |

**`creditSummary` strings**

| Score range | Summary suffix |
|-------------|---------------|
| ≥ 75 | `Excellent borrowing capacity` |
| ≥ 60 | `Good financial health` |
| ≥ 50 | `Moderate risk profile` |
| < 50 | `High risk — improve revenue or reduce spending` |

---

## Limits

All four endpoints are unauthenticated from the rate-limiter's perspective (rate-limiting is applied at the infrastructure level via Vercel / reverse proxy, not in route code). The credit-score endpoint does not require an API key at all; the other three are agent-scoped and require a valid Bearer token.

---

## Related

- [web/README.md](README.md) — General web API documentation
- [contracts/README.md](../contracts/README.md) — Soroban contract reference
