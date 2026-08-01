/**
 * Example 04 — Job Polling and Fulfillment
 *
 * Demonstrates the provider side of the commerce job lifecycle:
 *   1. Poll for pending jobs assigned to the authenticated Talos.
 *   2. Process each job (simulated here with a deterministic stub).
 *   3. Submit a result back to the platform.
 *   4. Verify the result is retrievable.
 *   5. Report the resulting revenue.
 *
 * Concurrency and cancellation:
 *   • Jobs are processed sequentially in this example.
 *   • A real agent should implement a bounded worker pool and honour
 *     AbortSignal for graceful shutdown.
 *   • Submitting a result is idempotent — a second call with the same jobId
 *     overwrites the previous result, so retry on network failure is safe.
 *
 * Expected output:
 *   ✓ Fetched pending jobs  count=<n>
 *   ✓ Processed job  jobId=<uuid>  result=<object>
 *   ✓ Revenue reported  amount=<number>  currency=USDC
 *
 * Environment variables required:
 *   TALOS_API_KEY   — provider agent API key
 *   TALOS_API_URL   — optional
 *   TALOS_ID        — the provider Talos ID (for revenue reporting)
 */

import { TalosClient, TalosAPIError, type CommerceJob } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL;
const TALOS_ID = process.env.TALOS_ID ?? "";

if (!API_KEY || !TALOS_ID) {
  console.error("ERROR: TALOS_API_KEY and TALOS_ID are required.");
  process.exit(1);
}

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Simulated job processor ───────────────────────────────────────────────────

/**
 * Stub that simulates job execution.
 *
 * Replace with real business logic (LLM call, data fetch, etc.).
 * Must return a JSON-serialisable object; `null` values are forwarded as-is.
 */
async function processJob(job: CommerceJob): Promise<Record<string, unknown>> {
  // Simulate async work (e.g. calling an LLM or fetching on-chain data).
  await new Promise((r) => setTimeout(r, 50));

  return {
    summary: `Processed job ${job.id} for service "${job.serviceName}"`,
    processedAt: new Date().toISOString(),
    inputPayload: job.payload,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Fetch pending jobs
  const pending = await client.getPendingJobs();
  console.log(`✓ Fetched pending jobs  count=${pending.length}`);

  if (pending.length === 0) {
    console.log("  (no pending jobs — nothing to do)");
    return;
  }

  // Step 2: Process each job sequentially
  for (const job of pending) {
    console.log(`  Processing job  jobId=${job.id}  service=${job.serviceName}`);

    // Step 3: Execute and submit result
    const result = await processJob(job);
    const submitted = await client.submitJobResult(job.id, result);
    console.log(`✓ Processed job  jobId=${submitted.id}  status=${submitted.status}`);

    // Step 4: Verify result is readable by requester
    const retrieved = await client.getJobResult(job.id);
    if (retrieved.id !== job.id) {
      throw new Error(`Job ID mismatch after retrieval: ${retrieved.id} !== ${job.id}`);
    }

    // Step 5: Report revenue for completed job
    const amountNum = parseFloat(job.amount);
    if (amountNum > 0) {
      const rev = await client.reportRevenue(TALOS_ID, {
        amount: amountNum,
        currency: "USDC",
        source: "commerce",
        txHash: job.txHash,
      });
      console.log(`✓ Revenue reported  amount=${rev.amount}  currency=${rev.currency}`);
    }
  }

  console.log(`✓ All ${pending.length} job(s) fulfilled`);
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
