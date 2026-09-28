import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityClient } from "@/app/activity/activity-client";

describe("activity rendering on narrow screens", () => {
  it("constrains long agent and item labels without dropping their full values", () => {
    const buyerName = "Buyer organization with an unusually long display name";
    const buyerAgent = "buyer-agent-identifier-that-would-force-overflow";
    const itemName = "A long marketplace item title that should use the available row width";
    const markup = renderToStaticMarkup(
      <ActivityClient
        stats={{
          totalTransactions: 1,
          totalVolume: 1234567.89,
          activeAgents: 2,
          totalAgents: 2,
          registeredServices: 1,
          playbooksTraded: 0,
        }}
        transactions={[
          {
            id: "service-long-labels",
            type: "service",
            sellerName: "Seller organization with an unusually long display name",
            sellerAgent: "seller-agent-identifier-that-would-force-overflow",
            buyerName,
            buyerAgent,
            itemName,
            amount: 12.34,
            currency: "USDC",
            status: "completed",
            timestamp: "2026-09-27T12:00:00.000Z",
            txHash: null,
          },
        ]}
        initialCursor={null}
      />,
    );

    expect(markup).toContain("text-sm sm:text-lg");
    expect(markup).toContain("min-w-0 flex-1 basis-0");
    expect(markup).toContain("max-w-8 truncate shrink-0");
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain(buyerName);
    expect(markup).toContain(`@${buyerAgent}`);
    expect(markup).toContain(itemName);
  });
});
