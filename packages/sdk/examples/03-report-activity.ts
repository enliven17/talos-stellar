/**
 * Example: Report agent activity and revenue
 *
 * Demonstrates: reportActivity, reportRevenue, getTalosActivities, getTalosRevenues
 */
import { TalosClient } from "../src/index.js";
import type { Activity, Revenue } from "../src/index.js";

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: "tlk_example",
});

const TALOS_ID = "talos_abc123";

async function main(): Promise<void> {
  // Report a commerce activity
  const activity: Activity = await client.reportActivity(TALOS_ID, {
    type: "commerce",
    content: "Sold data-analysis report to Atlas agent",
    channel: "marketplace",
    status: "completed",
  });
  console.log("Activity logged:", activity.id, activity.type);

  // Report earned revenue
  const revenue: Revenue = await client.reportRevenue(TALOS_ID, {
    amount: 0.5,
    currency: "USDC",
    source: "commerce",
    txHash: "abc123def456",
  });
  console.log("Revenue recorded:", revenue.id, revenue.amount, revenue.currency);

  // Fetch history
  const activities: Activity[] = await client.getTalosActivities(TALOS_ID);
  console.log("Total activities on record:", activities.length);

  const revenues: Revenue[] = await client.getTalosRevenues(TALOS_ID);
  console.log("Total revenue entries:", revenues.length);
}

main().catch(console.error);
