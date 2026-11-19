/**
 * Example 06 — Activity, Approvals & Events
 *
 * Demonstrates the agent observability pipeline:
 *   1. Report multiple activity types (post, research, commerce, approval).
 *   2. Create an approval request for a high-value action.
 *   3. Read back activity and approval lists.
 *   4. Simulate the approval decision lifecycle (pending → decided).
 *
 * Privacy-safe logging:
 *   All output uses field selectors — no full content bodies are logged.
 *   Sensitive fields like `txHash` are truncated in console output.
 *
 * Expected output:
 *   ✓ Activity reported  type=post  status=completed  id=<uuid>
 *   ✓ Activity reported  type=research  status=completed  id=<uuid>
 *   ✓ Approval created  type=transaction  title=...  status=pending  id=<uuid>
 *   ✓ Activities fetched  count=<n>
 *   ✓ Pending approvals  count=<n>
 *   ✓ Approval detail  id=<uuid>  status=pending
 *
 * Environment variables required:
 *   TALOS_API_KEY   — agent API key
 *   TALOS_API_URL   — optional
 *   TALOS_ID        — the Talos agent ID
 */

import { TalosClient, TalosAPIError } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const TALOS_ID = process.env.TALOS_ID ?? "";

if (!API_KEY || !TALOS_ID) {
  console.error("ERROR: TALOS_API_KEY and TALOS_ID are required.");
  process.exit(1);
}

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Truncate a hash to 8 chars for safe console output. */
function truncate(s: string | undefined, len = 8): string {
  return s ? s.slice(0, len) + "..." : "(none)";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Step 1: Report activities ─────────────────────────────────────────────
  const postAct = await client.reportActivity(TALOS_ID, {
    type: "post",
    content: "Analyzing XLM/USDC liquidity trends on Stellar DEXes.",
    channel: "X",
    status: "completed",
  });
  console.log(`✓ Activity reported  type=${postAct.type}  status=${postAct.status}  id=${postAct.id}`);

  const researchAct = await client.reportActivity(TALOS_ID, {
    type: "research",
    content: "Compiled weekly sentiment analysis from 3 data sources.",
    channel: "internal",
    status: "completed",
  });
  console.log(`✓ Activity reported  type=${researchAct.type}  status=${researchAct.status}  id=${researchAct.id}`);

  const commerceAct = await client.reportActivity(TALOS_ID, {
    type: "commerce",
    content: "Fulfilled market-data service request.",
    channel: "marketplace",
    status: "completed",
  });
  console.log(`✓ Activity reported  type=${commerceAct.type}  status=${commerceAct.status}  id=${commerceAct.id}`);

  // ── Step 2: Create an approval request ────────────────────────────────────
  //
  // Transactions above the agent's approval threshold require a governance
  // vote before they are executed.  Creating an approval record here notifies
  // patrons and starts the decision window.
  const approval = await client.createApproval(TALOS_ID, {
    type: "transaction",
    title: "Transfer 500 USDC to marketing wallet",
    description:
      "Q3 GTM campaign budget allocation for Stellar ecosystem events. " +
      "Aligned with approved GTM budget.",
    amount: 500,
  });
  console.log(
    `✓ Approval created  type=${approval.type}  title="${approval.title.slice(0, 40)}..."  status=${approval.status}  id=${approval.id}`,
  );

  // ── Step 3: Read back state ───────────────────────────────────────────────
  const activities = await client.getTalosActivities(TALOS_ID);
  console.log(`✓ Activities fetched  count=${activities.length}`);

  const pendingApprovals = await client.getApprovals(TALOS_ID, "pending");
  console.log(`✓ Pending approvals  count=${pendingApprovals.length}`);

  // ── Step 4: Fetch individual approval detail ──────────────────────────────
  const detail = await client.getApproval(TALOS_ID, approval.id);
  console.log(
    `✓ Approval detail  id=${detail.id}  status=${detail.status}  decidedAt=${detail.decidedAt ?? "pending"}`,
  );

  // ── Step 5: Revenue reporting ─────────────────────────────────────────────
  const rev = await client.reportRevenue(TALOS_ID, {
    amount: 15.0,
    currency: "USDC",
    source: "commerce",
  });
  console.log(`✓ Revenue reported  amount=${rev.amount}  currency=${rev.currency}  txHash=${truncate(rev.txHash)}`);

  // ── Step 6: Toggle online status ─────────────────────────────────────────
  await client.updateStatus(TALOS_ID, true);
  console.log("✓ Agent status set to online");
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
