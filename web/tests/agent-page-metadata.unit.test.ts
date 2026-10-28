import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that resolve the module
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    findFirst: vi.fn(),
  };
});

vi.mock("@/db", () => ({
  db: {
    query: {
      tlsTalos: {
        findFirst: mocks.findFirst,
      },
    },
  },
}));

vi.mock("@/db/schema", () => ({
  tlsTalos: {},
  tlsCommerceJobs: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the function under test after mocks are in place
// ---------------------------------------------------------------------------

import { generateMetadata } from "../src/app/agents/[id]/page";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateMetadata – /agents/[id]", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...OLD_ENV, NEXT_PUBLIC_APP_URL: "https://talos-stellar.vercel.app" };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns unique title and description for an active agent", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_001",
      name: "Vega",
      category: "Marketing",
      description: "Vega is an AI-powered marketing agent for SaaS founders.",
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_001"));

    expect(metadata.title).toBe("Vega (Marketing) — Talos");
    expect(metadata.description).toBe(
      "Vega is an AI-powered marketing agent for SaaS founders."
    );
    expect(metadata.robots).toBeUndefined();
  });

  it("sets noindex for a retired agent (status = Retired)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_002",
      name: "Atlas",
      category: "Research",
      description: "Atlas performs deep research tasks.",
      status: "Retired",
      deletedAt: null,
      retiredAt: new Date("2024-01-01"),
    });

    const metadata = await generateMetadata(makeParams("agent_002"));

    expect(metadata.title).toBe("Atlas (Research) — Talos");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("sets noindex for an agent with retiredAt set (legacy soft-retirement)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_003",
      name: "Nova",
      category: "Commerce",
      description: "Nova handles commerce jobs on Stellar.",
      status: "Active",           // status field may lag; retiredAt is the source of truth
      deletedAt: null,
      retiredAt: new Date("2024-06-01"),
    });

    const metadata = await generateMetadata(makeParams("agent_003"));

    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("sets noindex for a deleted agent (status = Deleted)", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_004",
      name: "Forge",
      category: "Infrastructure",
      description: "Forge manages infrastructure tasks.",
      status: "Deleted",
      deletedAt: new Date("2024-03-15"),
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_004"));

    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("includes Open Graph fields for an active agent", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_005",
      name: "Lens",
      category: "Analytics",
      description: "Lens analyses on-chain data for Stellar.",
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_005"));

    expect(metadata.openGraph).toMatchObject({
      title: "Lens (Analytics) — Talos",
      description: "Lens analyses on-chain data for Stellar.",
      url: "https://talos-stellar.vercel.app/agents/agent_005",
      siteName: "Talos",
      type: "profile",
    });
  });

  it("includes Twitter card fields for an active agent", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_006",
      name: "Radar",
      category: "Intelligence",
      description: "Radar tracks market signals on Stellar.",
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_006"));

    expect(metadata.twitter).toMatchObject({
      card: "summary",
      title: "Radar (Intelligence) — Talos",
      description: "Radar tracks market signals on Stellar.",
    });
  });

  it("includes a canonical URL for an active agent", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_007",
      name: "Pulse",
      category: "Finance",
      description: "Pulse tracks Stellar asset prices.",
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_007"));

    expect(metadata.alternates?.canonical).toBe(
      "https://talos-stellar.vercel.app/agents/agent_007"
    );
  });

  it("returns noindex and a fallback title when the agent is not found", async () => {
    mocks.findFirst.mockResolvedValue(undefined);

    const metadata = await generateMetadata(makeParams("nonexistent"));

    expect(metadata.title).toBe("Agent Not Found — Talos");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("truncates a description longer than 160 characters", async () => {
    const longDesc = "A".repeat(200);

    mocks.findFirst.mockResolvedValue({
      id: "agent_008",
      name: "Macro",
      category: "Strategy",
      description: longDesc,
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_008"));

    expect((metadata.description as string).length).toBeLessThanOrEqual(160);
    expect(metadata.description).toMatch(/\.\.\.$/);
  });

  it("falls back to a generated description when description is empty", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "agent_009",
      name: "Echo",
      category: "Communication",
      description: "",
      status: "Active",
      deletedAt: null,
      retiredAt: null,
    });

    const metadata = await generateMetadata(makeParams("agent_009"));

    expect(metadata.description).toBe(
      "Echo is a Communication agent on the Talos Protocol."
    );
  });
});
