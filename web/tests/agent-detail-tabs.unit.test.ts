/**
 * Smoke tests for the agent detail tab components.
 *
 * These tests do NOT use a DOM renderer (no jsdom). They verify:
 *   - The shared type shapes / constants exported from types.ts
 *   - Pure utility logic derived from the components (TYPE_ICONS, JOB_STATUS_STYLES)
 *   - The TABS constant has not been accidentally modified
 *
 * Tab components themselves rely on React hooks and cannot be called as
 * plain functions (unlike the simpler stateless components in
 * agent-view-states.unit.test.ts). Functional rendering tests require
 * a jsdom environment and live in a separate E2E/integration suite.
 */
import { describe, it, expect } from "vitest";
import {
  TABS,
  TYPE_ICONS,
  JOB_STATUS_STYLES,
  type TalosDetail,
  type Tab,
  type Approval,
  type DistPreview,
  type BuybackPreview,
} from "../src/app/agents/[id]/components/types";

// ── TABS constant ─────────────────────────────────────────────────────────────

describe("TABS constant", () => {
  it("contains exactly 7 tabs in the documented order", () => {
    expect(TABS).toEqual([
      "Overview",
      "Services",
      "Activity",
      "Patrons",
      "Revenue",
      "Governance",
      "Agent",
    ]);
  });

  it("all tab labels are non-empty strings (positive)", () => {
    for (const t of TABS) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("tab union type includes Overview and Agent (type-level check)", () => {
    const check: Tab = "Overview";
    expect(TABS.includes(check)).toBe(true);
    const check2: Tab = "Agent";
    expect(TABS.includes(check2)).toBe(true);
  });
});

// ── TYPE_ICONS ────────────────────────────────────────────────────────────────

describe("TYPE_ICONS", () => {
  it("maps all expected activity types to icons (positive)", () => {
    const expected = ["post", "research", "reply", "commerce", "approval"];
    for (const t of expected) {
      expect(TYPE_ICONS[t]).toBeDefined();
      expect(typeof TYPE_ICONS[t]).toBe("string");
      expect(TYPE_ICONS[t].length).toBeGreaterThan(0);
    }
  });

  it("returns undefined for unknown activity types (negative)", () => {
    // Unknown types should not have a mapping
    expect(TYPE_ICONS["unknown_type"]).toBeUndefined();
  });
});

// ── JOB_STATUS_STYLES ─────────────────────────────────────────────────────────

describe("JOB_STATUS_STYLES", () => {
  it("maps completed, pending, and failed to class strings (positive)", () => {
    expect(JOB_STATUS_STYLES["completed"]).toMatch(/text-accent/);
    expect(JOB_STATUS_STYLES["pending"]).toMatch(/text-muted/);
    expect(JOB_STATUS_STYLES["failed"]).toMatch(/text-red/);
  });

  it("returns undefined for unknown statuses (negative)", () => {
    expect(JOB_STATUS_STYLES["processing"]).toBeUndefined();
  });
});

// ── TalosDetail type shape ────────────────────────────────────────────────────

describe("TalosDetail type shape", () => {
  it("a valid minimal TalosDetail object satisfies all required fields (positive)", () => {
    const talos: TalosDetail = {
      id: "test-id",
      name: "TestAgent",
      agentName: "testagent",
      category: "Finance",
      description: "A test agent",
      status: "active",
      stellarAssetCode: "TEST:GABC1234",
      tokenSymbol: "TEST",
      pulsePrice: "$0.50",
      totalSupply: 1_000_000,
      creatorPublicKey: null,
      agentWalletAddress: null,
      persona: "Sharp and direct",
      targetAudience: "Developers",
      channels: ["X (Twitter)"],
      approvalThreshold: 100,
      gtmBudget: 500,
      minPatronPulse: 1000,
      investorShare: 25,
      agentOnline: true,
      agentLastSeen: null,
      createdAt: "2026-01-01",
      revenue: "$1,234",
      patronCount: 3,
      patrons: [],
      activities: [],
      revenueHistory: [],
      agentStats: { postsToday: 0, repliesToday: 0, researchesToday: 0 },
      service: null,
      jobStats: {
        total: 10,
        completed: 8,
        failed: 1,
        pending: 1,
        successRate: 80,
        totalRevenue: 500,
        jobsToday: 2,
      },
      recentJobs: [],
    };

    // Verify key fields are accessible and typed correctly
    expect(talos.id).toBe("test-id");
    expect(talos.totalSupply).toBe(1_000_000);
    expect(talos.jobStats.successRate).toBe(80);
    expect(Array.isArray(talos.patrons)).toBe(true);
    expect(Array.isArray(talos.activities)).toBe(true);
    expect(Array.isArray(talos.revenueHistory)).toBe(true);
  });

  it("talos.service can be null (optional service)", () => {
    const talos = { service: null } as Pick<TalosDetail, "service">;
    expect(talos.service).toBeNull();
  });
});

// ── Approval type shape ───────────────────────────────────────────────────────

describe("Approval type shape", () => {
  it("a valid Approval object has all required fields (positive)", () => {
    const approval: Approval = {
      id: "approval-1",
      type: "strategy",
      title: "Increase GTM budget",
      description: "We need more budget for Q4",
      amount: "500.00",
      status: "pending",
      decidedBy: null,
      createdAt: new Date().toISOString(),
    };

    expect(approval.id).toBe("approval-1");
    expect(approval.status).toBe("pending");
    expect(approval.decidedBy).toBeNull();
  });
});

// ── DistPreview type shape ────────────────────────────────────────────────────

describe("DistPreview type shape", () => {
  it("a valid DistPreview has correct numeric fields (positive)", () => {
    const preview: DistPreview = {
      totalRevenue: 1000,
      distributableAmount: 250,
      investorSharePercent: 25,
      breakdown: [
        {
          stellarPublicKey: "GABC" + "A".repeat(52),
          pulseAmount: 10000,
          sharePercent: "10.00",
          estimatedUsdc: "25.00",
        },
      ],
    };

    expect(preview.distributableAmount).toBeLessThan(preview.totalRevenue);
    expect(preview.breakdown).toHaveLength(1);
  });
});

// ── BuybackPreview type shape ─────────────────────────────────────────────────

describe("BuybackPreview type shape", () => {
  it("a valid BuybackPreview has expected numeric fields (positive)", () => {
    const preview: BuybackPreview = {
      totalRevenue: 5000,
      treasuryBalance: 4000,
      treasurySharePercent: 75,
      totalBuybackExecuted: 200,
      operatorMitosBalance: 900000,
      circulatingSupply: 100000,
    };

    expect(preview.circulatingSupply).toBeLessThan(preview.operatorMitosBalance + preview.circulatingSupply);
    expect(preview.treasurySharePercent).toBeGreaterThan(0);
  });
});

// ── minRequired derivation (logic extracted from detail-client) ────────────────

describe("minRequired derivation", () => {
  it("uses minPatronPulse when set (positive)", () => {
    const talos = { minPatronPulse: 5000, totalSupply: 1_000_000 } as Pick<
      TalosDetail,
      "minPatronPulse" | "totalSupply"
    >;
    const minRequired = talos.minPatronPulse ?? Math.floor(talos.totalSupply * 0.001);
    expect(minRequired).toBe(5000);
  });

  it("falls back to 0.1% of totalSupply when minPatronPulse is null (boundary)", () => {
    const talos = { minPatronPulse: null, totalSupply: 1_000_000 } as Pick<
      TalosDetail,
      "minPatronPulse" | "totalSupply"
    >;
    const minRequired = talos.minPatronPulse ?? Math.floor(talos.totalSupply * 0.001);
    expect(minRequired).toBe(1000);
  });

  it("floors the fallback correctly for non-round supplies (boundary)", () => {
    const talos = { minPatronPulse: null, totalSupply: 999_999 } as Pick<
      TalosDetail,
      "minPatronPulse" | "totalSupply"
    >;
    const minRequired = talos.minPatronPulse ?? Math.floor(talos.totalSupply * 0.001);
    expect(minRequired).toBe(999);
  });
});
