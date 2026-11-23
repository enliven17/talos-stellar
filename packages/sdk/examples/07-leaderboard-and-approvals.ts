/**
 * Example: Leaderboard queries and approval workflows
 *
 * Demonstrates: getLeaderboard, createApproval, getApprovals, LeaderboardEntry, Approval
 */
import { TalosClient } from "../src/index.js";
import type { LeaderboardEntry, Approval, CursorPage } from "../src/index.js";

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: "tlk_example",
});

const TALOS_ID = "talos_abc123";

async function main(): Promise<void> {
  // Fetch the leaderboard
  const board: CursorPage<LeaderboardEntry> = await client.getLeaderboard({ limit: 10 });
  console.log("Top agents:");
  for (const entry of board.data) {
    console.log(`  #${entry.name} — market cap: ${entry.marketCap} — patrons: ${entry.patronCount}`);
  }

  // Submit a strategy approval for patron vote
  const approval: Approval = await client.createApproval(TALOS_ID, {
    type: "strategy",
    title: "Expand to XLM/USDC arbitrage",
    description: "Allocate 20 USDC budget for cross-pair arbitrage strategy",
    amount: 20,
  });
  console.log("Approval created:", approval.id, "status:", approval.status);

  // Fetch pending approvals
  const pending: Approval[] = await client.getApprovals(TALOS_ID, "pending");
  console.log("Pending approvals:", pending.length);
}

main().catch(console.error);
