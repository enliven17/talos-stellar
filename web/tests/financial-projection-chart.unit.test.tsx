import "./setup-jsdom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import {
  FinancialProjectionChart,
  FinancialProjectionData,
  getRevenueTrendSummary,
  getBudgetTrendSummary,
} from "../src/components/financial-projection-chart";

// Mock recharts ResponsiveContainer for DOM test environment
vi.mock("recharts", async () => {
  const original = await vi.importActual<Record<string, unknown>>("recharts");
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: 800, height: 400 }}>
        {children}
      </div>
    ),
  };
});

const fixtureData: FinancialProjectionData = {
  projection: {
    expectedRevenue: {
      monthly: [1200, 1500, 1800, 2200, 2600, 3100],
      quarterly: [4500, 7900],
      yearly: 12400,
    },
    budgetSuggestions: [
      {
        category: "Marketing",
        amount: 2500,
        rationale: "Expand social outreach",
      },
      {
        category: "Infrastructure",
        amount: 1500,
        rationale: "Server capacity scaling",
      },
      {
        category: "R&D",
        amount: 3200,
        rationale: "Model fine-tuning and evaluation",
      },
    ],
    roiEstimations: {
      shortTerm: 14,
      mediumTerm: 28,
      longTerm: 52,
      confidence: "high",
    },
    insights: ["Steady growth trajectory", "Healthy margin expansion"],
  },
};

describe("FinancialProjectionChart Accessibility & Table Fallbacks", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders both charts wrapped in figures with accessible names and figcaption summaries", () => {
    render(<FinancialProjectionChart talosId="agent-123" initialData={fixtureData} />);

    // Figures with accessible names
    const figures = screen.getAllByRole("figure");
    expect(figures.length).toBe(2);

    const revenueFigure = screen.getByRole("figure", {
      name: /ai revenue projection/i,
    });
    expect(revenueFigure).toBeTruthy();

    const budgetFigure = screen.getByRole("figure", {
      name: /ai budget suggestions/i,
    });
    expect(budgetFigure).toBeTruthy();

    // Verify figcaption summaries inside figures
    const revenueFigcaption = revenueFigure.querySelector("figcaption");
    expect(revenueFigcaption).toBeTruthy();
    expect(revenueFigcaption?.textContent).toMatch(/trends upward/i);
    expect(revenueFigcaption?.textContent).toContain("$1200.00");
    expect(revenueFigcaption?.textContent).toContain("$3100.00");

    const budgetFigcaption = budgetFigure.querySelector("figcaption");
    expect(budgetFigcaption).toBeTruthy();
    expect(budgetFigcaption?.textContent).toMatch(/budget suggestions across 3 categories/i);
    expect(budgetFigcaption?.textContent).toContain("R&D");
  });

  it("renders revenue projection table rows matching the fixture data points", () => {
    render(<FinancialProjectionChart talosId="agent-123" initialData={fixtureData} />);

    const revenueTable = screen.getByRole("table", {
      name: /monthly projected revenue/i,
    });
    expect(revenueTable).toBeTruthy();

    // Verify headers
    const headers = within(revenueTable).getAllByRole("columnheader");
    expect(headers[0].textContent).toBe("Month");
    expect(headers[1].textContent).toBe("Projected Revenue");

    // Verify data rows
    const rows = within(revenueTable).getAllByRole("row").slice(1); // skip header row
    expect(rows.length).toBe(fixtureData.projection.expectedRevenue.monthly.length);

    fixtureData.projection.expectedRevenue.monthly.forEach((val, idx) => {
      const cells = within(rows[idx]).getAllByRole("cell");
      expect(cells[0].textContent).toBe(`M${idx + 1}`);
      expect(cells[1].textContent).toBe(`$${val.toFixed(2)}`);
    });
  });

  it("renders budget suggestions table rows matching the fixture data points", () => {
    render(<FinancialProjectionChart talosId="agent-123" initialData={fixtureData} />);

    const budgetTable = screen.getByRole("table", {
      name: /ai budget suggestions/i,
    });
    expect(budgetTable).toBeTruthy();

    // Verify headers
    const headers = within(budgetTable).getAllByRole("columnheader");
    expect(headers[0].textContent).toBe("Category");
    expect(headers[1].textContent).toBe("Amount");

    // Verify data rows
    const rows = within(budgetTable).getAllByRole("row").slice(1); // skip header row
    expect(rows.length).toBe(fixtureData.projection.budgetSuggestions.length);

    fixtureData.projection.budgetSuggestions.forEach((item, idx) => {
      const cells = within(rows[idx]).getAllByRole("cell");
      expect(cells[0].textContent).toBe(item.category);
      expect(cells[1].textContent).toBe(`$${item.amount.toFixed(2)}`);
    });
  });

  it("toggles table visibility when clicking toggle buttons", () => {
    render(<FinancialProjectionChart talosId="agent-123" initialData={fixtureData} />);

    const revenueToggle = screen.getByRole("button", {
      name: /show revenue data table/i,
    });
    const revenueTableContainer = document.getElementById("revenue-projection-table");

    // Initially visually hidden (sr-only)
    expect(revenueTableContainer?.className).toContain("sr-only");
    expect(revenueToggle.getAttribute("aria-expanded")).toBe("false");

    // Click to show
    fireEvent.click(revenueToggle);
    expect(revenueTableContainer?.className).not.toContain("sr-only");
    expect(revenueTableContainer?.className).toContain("overflow-x-auto");
    expect(revenueToggle.getAttribute("aria-expanded")).toBe("true");
    expect(revenueToggle.getAttribute("aria-label")).toMatch(/hide revenue data table/i);

    // Click to hide again
    fireEvent.click(revenueToggle);
    expect(revenueTableContainer?.className).toContain("sr-only");
    expect(revenueToggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders with fetch data when initialData is not provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => fixtureData,
      })
    );

    render(<FinancialProjectionChart talosId="agent-fetch" />);

    // Wait for data to load
    const revenueTable = await screen.findByRole("table", {
      name: /monthly projected revenue/i,
    });
    expect(revenueTable).toBeTruthy();

    const rows = within(revenueTable).getAllByRole("row").slice(1);
    expect(rows.length).toBe(6);
  });
});

describe("Trend calculation unit tests", () => {
  it("computes upward, downward, and flat revenue trends", () => {
    expect(getRevenueTrendSummary([100, 200])).toMatch(/trends upward/i);
    expect(getRevenueTrendSummary([300, 150])).toMatch(/trends downward/i);
    expect(getRevenueTrendSummary([200, 200])).toMatch(/remains steady/i);
    expect(getRevenueTrendSummary([])).toMatch(/no projected revenue/i);
  });

  it("computes budget trend with totals and highest allocation", () => {
    const suggestions = [
      { category: "Ops", amount: 100 },
      { category: "Marketing", amount: 500 },
    ];
    const trend = getBudgetTrendSummary(suggestions);
    expect(trend).toContain("$600.00");
    expect(trend).toContain("Marketing");
    expect(getBudgetTrendSummary([])).toMatch(/no budget suggestions/i);
  });
});
