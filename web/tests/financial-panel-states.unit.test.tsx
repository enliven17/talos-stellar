// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  FinancialSnapshotBadge,
  FinancialMetricValue,
  FINANCIAL_STALE_AFTER_MS,
  isTimestampStale,
  getRelativeTimeString,
} from "../src/components/financial-state";
import { TabRevenue } from "../src/app/agents/[id]/components/TabRevenue";
import type { TalosDetail, DistPreview, BuybackPreview } from "../src/app/agents/[id]/components/types";

describe("Financial Snapshot & Data States", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe("Snapshot Timestamps & Relative Formatting", () => {
    it("correctly identifies live vs stale timestamps", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const recentIso = new Date(now - 5000).toISOString();
      const staleIso = new Date(now - FINANCIAL_STALE_AFTER_MS - 1000).toISOString();

      expect(isTimestampStale(recentIso)).toBe(false);
      expect(isTimestampStale(staleIso)).toBe(true);
      expect(isTimestampStale(null)).toBe(true);
      expect(isTimestampStale(undefined)).toBe(true);
    });

    it("formats relative observation times accurately", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      expect(getRelativeTimeString(new Date(now - 2000))).toBe("just now");
      expect(getRelativeTimeString(new Date(now - 15000))).toBe("15s ago");
      expect(getRelativeTimeString(new Date(now - 120000))).toBe("2m ago");
      expect(getRelativeTimeString(new Date(now - 7200000))).toBe("2h ago");
      expect(getRelativeTimeString(new Date(now - 172800000))).toBe("2d ago");
    });

    it("renders live snapshot badge with formatted time", () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const observedAt = new Date(now - 5000).toISOString();

      render(<FinancialSnapshotBadge observedAt={observedAt} />);

      expect(screen.getByTestId("financial-snapshot-badge")).not.toBeNull();
      expect(screen.getByTestId("financial-state-tag").textContent).toBe("live");
      expect(screen.getByTestId("financial-observed-at").textContent).toBe("as of just now");
    });

    it("renders stale state badge and surfaces refresh affordance", () => {
      const now = Date.now();
      vi.setSystemTime(now);
      const observedAt = new Date(now - 45000).toISOString();
      const onRefresh = vi.fn();

      render(<FinancialSnapshotBadge observedAt={observedAt} onRefresh={onRefresh} />);

      expect(screen.getByTestId("financial-state-tag").textContent).toBe("stale");
      expect(screen.getByTestId("financial-observed-at").textContent).toBe("as of 45s ago");

      const refreshBtn = screen.getByTestId("financial-stale-refresh-button");
      expect(refreshBtn).not.toBeNull();
      fireEvent.click(refreshBtn);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("Distinguishing Loading, Stale, and Unavailable States Without Inventing Zeros", () => {
    it("renders loading indicator instead of invented $0.00", () => {
      render(
        <FinancialMetricValue
          value={null}
          state="loading"
          prefix="$"
          testId="metric-loading"
        />
      );

      const el = screen.getByTestId("metric-loading");
      expect(el.textContent).toBe("•••");
      expect(el.textContent).not.toContain("$0.00");
      expect(el.textContent).not.toContain("0");
    });

    it("renders unavailable placeholder — instead of invented $0.00 when data is null or unavailable", () => {
      render(
        <FinancialMetricValue
          value={null}
          state="unavailable"
          prefix="$"
          testId="metric-unavailable"
        />
      );

      const el = screen.getByTestId("metric-unavailable");
      expect(el.textContent).toBe("—");
      expect(el.textContent).not.toContain("$0.00");
    });

    it("renders live values with prefix/suffix when available", () => {
      render(
        <FinancialMetricValue
          value="1,250.50"
          state="live"
          prefix="$"
          suffix=" USDC"
          testId="metric-live"
        />
      );

      const el = screen.getByTestId("metric-live");
      expect(el.textContent).toBe("$1,250.50 USDC");
    });
  });

  describe("TabRevenue Financial Panels with Snapshot Timestamps & Failure Boundaries", () => {
    const mockTalos: TalosDetail = {
      id: "talos-1",
      name: "Alpha Corp",
      agentName: "Alpha",
      category: "Finance",
      description: "Autonomous finance agent",
      status: "Active",
      stellarAssetCode: "ALPHA:GABC",
      tokenSymbol: "ALPHA",
      pulsePrice: "$1.05",
      totalSupply: 1000000,
      creatorPublicKey: "GCREATOR",
      agentWalletAddress: "GWALLET",
      persona: "Analyst",
      targetAudience: "Patrons",
      channels: ["web"],
      approvalThreshold: 100,
      gtmBudget: 500,
      minPatronPulse: 10,
      investorShare: 25,
      agentOnline: true,
      agentLastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      revenue: "$12,450.00",
      patronCount: 5,
      patrons: [],
      activities: [],
      revenueHistory: [
        { month: "Jan", amount: 3000 },
        { month: "Feb", amount: 4500 },
      ],
      agentStats: { postsToday: 2, repliesToday: 4, researchesToday: 1 },
      service: null,
      jobStats: {
        total: 10,
        completed: 9,
        failed: 1,
        pending: 0,
        successRate: 90,
        totalRevenue: 4950,
        jobsToday: 2,
      },
      recentJobs: [],
      observedAt: new Date(Date.now() - 5000).toISOString(),
    };

    it("renders distribution panel with snapshot timestamp when loaded", () => {
      const distPreview: DistPreview = {
        totalRevenue: 1000,
        distributableAmount: 250,
        investorSharePercent: 25,
        breakdown: [
          {
            stellarPublicKey: "GPATRON1",
            pulseAmount: 500,
            sharePercent: "50.00",
            estimatedUsdc: "125.00",
          },
        ],
        observedAt: new Date(Date.now() - 10000).toISOString(),
      };

      render(
        <TabRevenue
          talos={mockTalos}
          address="GPATRON1"
          isConnected={true}
          distPreview={distPreview}
          distLoading={false}
          onLoadDistPreview={vi.fn()}
          onDistribute={vi.fn()}
          buybackPreview={null}
          buybackLoading={false}
          buybackForm={{ usdcAmount: "", mitosAmount: "" }}
          onBuybackFormChange={vi.fn()}
          onLoadBuybackPreview={vi.fn()}
          onBuyback={vi.fn()}
        />
      );

      // Financial overview and distribution badges
      expect(screen.getAllByTestId("financial-snapshot-badge").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("$250.00")).not.toBeNull();
      expect(screen.getByText("$1000.00")).not.toBeNull();
    });

    it("displays error state without invented zero balances when distribution preview fails", () => {
      render(
        <TabRevenue
          talos={mockTalos}
          address="GPATRON1"
          isConnected={true}
          distPreview={null}
          distLoading={false}
          onLoadDistPreview={vi.fn()}
          onDistribute={vi.fn()}
          buybackPreview={null}
          buybackLoading={false}
          buybackForm={{ usdcAmount: "", mitosAmount: "" }}
          onBuybackFormChange={vi.fn()}
          onLoadBuybackPreview={vi.fn()}
          onBuyback={vi.fn()}
          distError="Distribution preview unavailable"
        />
      );

      expect(screen.getByText("Distribution preview unavailable")).not.toBeNull();
      // Ensure invented zero values are not shown
      expect(screen.queryByText("$0.00 Total Treasury")).toBeNull();
    });

    it("renders buyback panel with snapshot timestamp and safe metric values", () => {
      const buybackPreview: BuybackPreview = {
        totalRevenue: 5000,
        treasuryBalance: 750,
        treasurySharePercent: 15,
        totalBuybackExecuted: 200,
        operatorMitosBalance: 100,
        circulatingSupply: 999900,
        observedAt: new Date(Date.now() - 60000).toISOString(), // stale
      };

      const loadBuyback = vi.fn();

      render(
        <TabRevenue
          talos={mockTalos}
          address="GPATRON1"
          isConnected={true}
          distPreview={null}
          distLoading={false}
          onLoadDistPreview={vi.fn()}
          onDistribute={vi.fn()}
          buybackPreview={buybackPreview}
          buybackLoading={false}
          buybackForm={{ usdcAmount: "50", mitosAmount: "50" }}
          onBuybackFormChange={vi.fn()}
          onLoadBuybackPreview={loadBuyback}
          onBuyback={vi.fn()}
        />
      );

      // Buyback button text and metrics
      expect(screen.getByText("Burn 50 ALPHA")).not.toBeNull();
      expect(screen.getByText("$750.00")).not.toBeNull();
      expect(screen.getByText("$200.00")).not.toBeNull();
    });
  });
});
