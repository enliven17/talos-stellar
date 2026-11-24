import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsClient, type TalosListItem } from "../src/app/agents/agents-client";

function agent(id: string, overrides: Partial<TalosListItem> = {}): TalosListItem {
  return {
    id,
    name: `Agent ${id}`,
    agentName: null,
    category: "Research",
    description: "Public research agent",
    status: "Active",
    agentOnline: true,
    agentLastSeen: new Date().toISOString(),
    patrons: 0,
    revenue: 0,
    revenueDisplay: "$0",
    pulsePrice: 1,
    pulsePriceDisplay: "$1.00",
    serviceName: "Research brief",
    serviceDescription: "A concise report",
    servicePrice: 0.012,
    servicePriceDisplay: "0.012 USDC",
    servicePriceExact: "0.012000",
    serviceCurrency: "USDC",
    framework: "OpenClaw",
    channels: ["Web"],
    totalJobs: 0,
    completedJobs: 0,
    successRate: null,
    lastActivity: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("agent directory comparison", () => {
  it("shows a clear empty state before any agents are selected", () => {
    render(<AgentsClient agents={[agent("one")]} />);

    expect(screen.getByRole("heading", { name: "Compare selected agents" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("No agents selected");
  });

  it("compares public fields, exact price units, and explicitly unknown or missing data", () => {
    render(
      <AgentsClient
        agents={[
          agent("one"),
          agent("two", {
            channels: [],
            framework: null,
            serviceName: null,
            serviceDescription: null,
            servicePrice: null,
            servicePriceDisplay: null,
            servicePriceExact: null,
            serviceCurrency: null,
            agentLastSeen: null,
            agentOnline: false,
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Agent one to comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Agent two to comparison" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("0.012000 USDC")).toBeTruthy();
    expect(within(table).getByText("Web")).toBeTruthy();
    expect(within(table).getByText("Available (fresh observation)")).toBeTruthy();
    expect(within(table).getByText("Unknown — no observation")).toBeTruthy();
    expect(within(table).getAllByText("Not listed").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText(/Prices are shown in each listing’s stated currency per request/)).toBeTruthy();
  });

  it("does not allow more than three agents in the comparison", () => {
    render(<AgentsClient agents={[agent("one"), agent("two"), agent("three"), agent("four")]} />);
    for (const id of ["one", "two", "three"]) {
      fireEvent.click(screen.getByRole("button", { name: `Add Agent ${id} to comparison` }));
    }

    expect(screen.getByRole("button", { name: "Add Agent four to comparison" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
  });
});
