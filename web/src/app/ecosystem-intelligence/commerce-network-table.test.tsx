import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommerceNetworkTable } from "./commerce-network-table";

describe("CommerceNetworkTable", () => {
  it("provides a semantic fallback with the same edge fields as the graph", () => {
    const markup = renderToStaticMarkup(
      <CommerceNetworkTable edges={[
        {
          buyer: { id: "buyer-1", name: "Buyer One" },
          seller: { id: "seller-1", name: "Seller One" },
          jobCount: 6,
          volume: 14.25,
        },
      ]} />,
    );

    expect(markup).toContain("<table");
    expect(markup).toContain("Buyer One");
    expect(markup).toContain("Seller One");
    expect(markup).toContain(">6</td>");
    expect(markup).toContain(">14.25</td>");
    expect(markup).toContain("Completed commerce between buyer and seller agents.");
  });
});