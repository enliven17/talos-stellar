import { describe, it, expect, beforeAll } from "vitest";

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

function api(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

// Shared state across the test flow
let talosId: string;
let apiKey: string;
let approvalId: string;
let playbookId: string;

// ────────────────────────────────────────────
// 1. Talos CRUD
// ────────────────────────────────────────────

describe("POST /api/talos — create", () => {
  it("creates a talos and returns apiKeyOnce", async () => {
    const res = await api("/api/talos", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E Test Agent",
        category: "Development",
        description: "Created by e2e test suite",
        totalSupply: 500_000,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.id).toBeDefined();
    expect(body.name).toBe("E2E Test Agent");
    expect(body.category).toBe("Development");
    expect(body.status).toBe("Active");
    expect(body.totalSupply).toBe(500_000);
    expect(body.apiKeyOnce).toBeDefined();
    expect(typeof body.apiKeyOnce).toBe("string");

    talosId = body.id;
    apiKey = body.apiKeyOnce;
  });

  it("rejects invalid category", async () => {
    const res = await api("/api/talos", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad",
        category: "InvalidCategory",
        description: "Should fail",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const res = await api("/api/talos", {
      method: "POST",
      body: JSON.stringify({ name: "Incomplete" }),
    });
    expect(res.status).toBe(400);
  });

});

describe("GET /api/talos — list", () => {
  it("returns an array including the created talos", async () => {
    const res = await api("/api/talos");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((c: { id: string }) => c.id === talosId);
    expect(found).toBeDefined();
    expect(found.name).toBe("E2E Test Agent");
    // apiKey should NOT be exposed in list
    expect(found.apiKey).toBeUndefined();
  });
});

describe("GET /api/talos/:id — detail", () => {
  it("returns full talos with relations", async () => {
    const res = await api(`/api/talos/${talosId}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(talosId);
    expect(body.name).toBe("E2E Test Agent");
    expect(Array.isArray(body.patrons)).toBe(true);
    expect(Array.isArray(body.activities)).toBe(true);
    expect(Array.isArray(body.approvals)).toBe(true);
    expect(Array.isArray(body.revenues)).toBe(true);
  });

  it("returns 404 for non-existent id", async () => {
    const res = await api("/api/talos/nonexistent_id_12345");
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────
// 2. Activity (agent reporting)
// ────────────────────────────────────────────

describe("POST /api/talos/:id/activity — report activity", () => {
  it("rejects without auth", async () => {
    const res = await api(`/api/talos/${talosId}/activity`, {
      method: "POST",
      body: JSON.stringify({
        type: "post",
        content: "No auth test",
        channel: "X",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with wrong api key", async () => {
    const res = await api(`/api/talos/${talosId}/activity`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong_key_here" },
      body: JSON.stringify({
        type: "post",
        content: "Wrong key test",
        channel: "X",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("creates activity with valid api key", async () => {
    const res = await api(`/api/talos/${talosId}/activity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        type: "post",
        content: "E2E test post on X",
        channel: "X",
        status: "completed",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.talosId).toBe(talosId);
    expect(body.type).toBe("post");
    expect(body.channel).toBe("X");
  });

  it("rejects invalid activity type", async () => {
    const res = await api(`/api/talos/${talosId}/activity`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        type: "invalid_type",
        content: "Should fail",
        channel: "X",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/talos/:id/activity — list activities", () => {
  it("returns activities for the talos", async () => {
    const res = await api(`/api/talos/${talosId}/activity`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].type).toBe("post");
  });
});

// ────────────────────────────────────────────
// 3. Agent status
// ────────────────────────────────────────────

describe("PATCH /api/talos/:id/status — agent heartbeat", () => {
  it("rejects without auth", async () => {
    const res = await api(`/api/talos/${talosId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ agentOnline: true }),
    });
    expect(res.status).toBe(401);
  });

  it("sets agent online", async () => {
    const res = await api(`/api/talos/${talosId}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ agentOnline: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentOnline).toBe(true);
    expect(body.agentLastSeen).toBeDefined();
  });

  it("sets agent offline", async () => {
    const res = await api(`/api/talos/${talosId}/status`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ agentOnline: false }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).agentOnline).toBe(false);
  });
});

// ────────────────────────────────────────────
// 3.5 Patrons (Become Patron / Withdraw)
// ────────────────────────────────────────────

describe("GET /api/talos/:id/patrons — list patrons", () => {
  it("returns empty list initially", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("returns 404 for non-existent talos", async () => {
    const res = await api("/api/talos/nonexistent_12345/patrons");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/talos/:id/patrons — become patron", () => {
  it("rejects without walletAddress", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ pulseAmount: 1000 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects without pulseAmount", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects when below minimum threshold", async () => {
    // Default min = totalSupply(500_000) * 0.001 = 500
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON", pulseAmount: 100 }),
    });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.minRequired).toBe(500);
    expect(body.current).toBe(100);
  });

  it("registers as patron when meeting threshold", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON", pulseAmount: 1000 }),
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.talosId).toBe(talosId);
    expect(body.walletAddress).toBe("0xE2E_PATRON");
    expect(body.role).toBe("Investor");
    expect(body.status).toBe("active");
    expect(body.pulseAmount).toBe(1000);
  });

  it("rejects duplicate patron registration", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON", pulseAmount: 1000 }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent talos", async () => {
    const res = await api("/api/talos/nonexistent_12345/patrons", {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON", pulseAmount: 1000 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/talos/:id/patrons — list after registration", () => {
  it("includes the registered patron", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const found = body.find(
      (p: { walletAddress: string }) => p.walletAddress === "0xE2E_PATRON"
    );
    expect(found).toBeDefined();
    expect(found.status).toBe("active");
  });
});

describe("DELETE /api/talos/:id/patrons — withdraw patron", () => {
  it("rejects without walletAddress", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-patron wallet", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "DELETE",
      body: JSON.stringify({ walletAddress: "0xNOBODY" }),
    });
    expect(res.status).toBe(404);
  });

  it("withdraws patron status", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "DELETE",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON" }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("revoked");
  });

  it("can re-register after withdrawal", async () => {
    const res = await api(`/api/talos/${talosId}/patrons`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: "0xE2E_PATRON", pulseAmount: 2000 }),
    });
    expect(res.status).toBe(200); // re-activation returns 200, not 201

    const body = await res.json();
    expect(body.status).toBe("active");
    expect(body.pulseAmount).toBe(2000);
  });
});

// ────────────────────────────────────────────
// 4. Approvals
// ────────────────────────────────────────────

describe("POST /api/talos/:id/approvals — create approval", () => {
  it("creates a pending approval", async () => {
    const res = await api(`/api/talos/${talosId}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        type: "transaction",
        title: "E2E budget request",
        description: "Test approval flow",
        amount: 42.5,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.talosId).toBe(talosId);
    expect(body.type).toBe("transaction");
    expect(body.status).toBe("pending");

    approvalId = body.id;
  });

  it("rejects invalid approval type", async () => {
    const res = await api(`/api/talos/${talosId}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        type: "invalid_type",
        title: "Should fail",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative amount", async () => {
    const res = await api(`/api/talos/${talosId}/approvals`, {
      method: "POST",
      body: JSON.stringify({
        type: "transaction",
        title: "Negative",
        amount: -10,
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/talos/:id/approvals — list approvals", () => {
  it("returns approvals including the one we created", async () => {
    const res = await api(`/api/talos/${talosId}/approvals`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((a: { id: string }) => a.id === approvalId);
    expect(found).toBeDefined();
    expect(found.status).toBe("pending");
  });
});

describe("PATCH /api/talos/:id/approvals/:approvalId — decide", () => {
  it("rejects invalid status", async () => {
    const res = await api(
      `/api/talos/${talosId}/approvals/${approvalId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "maybe" }),
      }
    );
    expect(res.status).toBe(400);
  });

  it("approves the approval", async () => {
    const res = await api(
      `/api/talos/${talosId}/approvals/${approvalId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "approved",
          decidedBy: "0xE2Etest",
        }),
      }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("approved");
    expect(body.decidedAt).toBeDefined();
    expect(body.decidedBy).toBe("0xE2Etest");
  });
});

// ────────────────────────────────────────────
// 5. Revenue
// ────────────────────────────────────────────

describe("POST /api/talos/:id/revenue — report revenue", () => {
  it("rejects without auth", async () => {
    const res = await api(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      body: JSON.stringify({
        amount: 100,
        source: "commerce",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("records revenue with valid api key", async () => {
    const res = await api(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        amount: 250.5,
        source: "commerce",
        currency: "USDC",
        txHash: "0xE2E_TEST_TX",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.talosId).toBe(talosId);
    expect(body.source).toBe("commerce");
    expect(body.txHash).toBe("0xE2E_TEST_TX");
    expect(parseFloat(body.amount)).toBeCloseTo(250.5);
  });

  it("rejects invalid source", async () => {
    const res = await api(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ amount: 10, source: "invalid_source" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects zero or negative amount", async () => {
    const res = await api(`/api/talos/${talosId}/revenue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ amount: 0, source: "commerce" }),
    });
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────
// 6. Leaderboard
// ────────────────────────────────────────────

describe("GET /api/leaderboard", () => {
  it("returns ranked talos list", async () => {
    const res = await api("/api/leaderboard");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((c: { id: string }) => c.id === talosId);
    expect(found).toBeDefined();
    expect(found.name).toBe("E2E Test Agent");
    expect(typeof found.totalRevenue).toBe("number");
    expect(typeof found.marketCap).toBe("number");
  });
});

// ────────────────────────────────────────────
// 7. Playbooks
// ────────────────────────────────────────────

describe("POST /api/playbooks — create playbook", () => {
  it("rejects without auth", async () => {
    const res = await api("/api/playbooks", {
      method: "POST",
      body: JSON.stringify({
        title: "No Auth Playbook",
        category: "Targeting",
        channel: "X",
        description: "Should fail",
        price: 1.0,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid category", async () => {
    const res = await api("/api/playbooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        title: "Bad Cat",
        category: "InvalidCat",
        channel: "X",
        description: "Should fail",
        price: 1.0,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid channel", async () => {
    const res = await api("/api/playbooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        title: "Bad Channel",
        category: "Targeting",
        channel: "TikTok",
        description: "Should fail",
        price: 1.0,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a playbook with valid api key", async () => {
    const res = await api("/api/playbooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        title: "E2E Test Playbook",
        category: "Channel Strategy",
        channel: "X",
        description: "A playbook created by e2e tests",
        price: 0.99,
        tags: ["e2e", "test"],
        impressions: 1000,
        engagementRate: 5.5,
        conversions: 10,
        periodDays: 14,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("E2E Test Playbook");
    expect(body.talosId).toBe(talosId);
    expect(body.status).toBe("active");
    expect(body.tags).toEqual(["e2e", "test"]);

    playbookId = body.id;
  });
});

describe("GET /api/playbooks — list playbooks", () => {
  it("returns list including created playbook", async () => {
    const res = await api("/api/playbooks");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((p: { id: string }) => p.id === playbookId);
    expect(found).toBeDefined();
    expect(found.title).toBe("E2E Test Playbook");
    expect(found.talos).toBe("E2E Test Agent");
    expect(typeof found.purchases).toBe("number");
  });

  it("filters by category", async () => {
    const res = await api("/api/playbooks?category=Channel+Strategy");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.every((p: { category: string }) => p.category === "Channel Strategy")).toBe(true);
  });

  it("filters by channel", async () => {
    const res = await api("/api/playbooks?channel=X");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.every((p: { channel: string }) => p.channel === "X")).toBe(true);
  });
});

describe("GET /api/playbooks/:id — playbook detail", () => {
  it("returns playbook with talos name", async () => {
    const res = await api(`/api/playbooks/${playbookId}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(playbookId);
    expect(body.talos).toBe("E2E Test Agent");
    expect(typeof body.purchases).toBe("number");
  });

  it("returns 404 for non-existent id", async () => {
    const res = await api("/api/playbooks/nonexistent_12345");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/playbooks/:id — update playbook", () => {
  it("rejects without auth", async () => {
    const res = await api(`/api/playbooks/${playbookId}`, {
      method: "PATCH",
      body: JSON.stringify({ price: 2.0 }),
    });
    expect(res.status).toBe(401);
  });

  it("updates price and version", async () => {
    const res = await api(`/api/playbooks/${playbookId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ price: 1.5, version: 2 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(parseFloat(body.price)).toBeCloseTo(1.5);
    expect(body.version).toBe(2);
  });

  it("rejects invalid status", async () => {
    const res = await api(`/api/playbooks/${playbookId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ status: "deleted" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/playbooks/:id/purchase — purchase playbook", () => {
  it("rejects without buyerAddress", async () => {
    const res = await api(`/api/playbooks/${playbookId}/purchase`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("purchases a playbook", async () => {
    const res = await api(`/api/playbooks/${playbookId}/purchase`, {
      method: "POST",
      body: JSON.stringify({
        buyerAddress: "0xE2E_BUYER",
        txHash: "0xE2E_PURCHASE_TX",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.playbookId).toBe(playbookId);
    expect(body.buyerAddress).toBe("0xE2E_BUYER");
  });

  it("rejects duplicate purchase", async () => {
    const res = await api(`/api/playbooks/${playbookId}/purchase`, {
      method: "POST",
      body: JSON.stringify({ buyerAddress: "0xE2E_BUYER" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent playbook", async () => {
    const res = await api("/api/playbooks/nonexistent_12345/purchase", {
      method: "POST",
      body: JSON.stringify({ buyerAddress: "0xSomeone" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/playbooks/purchased — purchased playbooks", () => {
  it("rejects without wallet param", async () => {
    const res = await api("/api/playbooks/purchased");
    expect(res.status).toBe(400);
  });

  it("returns purchased playbooks for buyer", async () => {
    const res = await api("/api/playbooks/purchased?wallet=0xE2E_BUYER");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);

    const found = body.find(
      (pp: { playbook: { id: string } }) => pp.playbook.id === playbookId
    );
    expect(found).toBeDefined();
    expect(found.playbook.title).toBe("E2E Test Playbook");
  });

  it("returns empty for unknown wallet", async () => {
    const res = await api("/api/playbooks/purchased?wallet=0xNOBODY");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /api/playbooks/my — my playbooks", () => {
  it("rejects without wallet param", async () => {
    const res = await api("/api/playbooks/my");
    expect(res.status).toBe(400);
  });
});

// ────────────────────────────────────────────
// 8. Full lifecycle verification
// ────────────────────────────────────────────

// ────────────────────────────────────────────
// 7.5 Read endpoints (dashboard, leaderboard, activity, services)
// ────────────────────────────────────────────

describe("GET /api/leaderboard", () => {
  it("returns leaderboard with computed fields", async () => {
    const res = await api("/api/leaderboard");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const found = body.find((c: { id: string }) => c.id === talosId);
    expect(found).toBeDefined();
    expect(typeof found.patronCount).toBe("number");
    expect(typeof found.activityCount).toBe("number");
    expect(typeof found.totalRevenue).toBe("number");
    expect(typeof found.marketCap).toBe("number");
  });
});

describe("GET /api/activity", () => {
  it("returns activity feed with transactions", async () => {
    const res = await api("/api/activity");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats).toBeDefined();
    expect(typeof body.stats.totalAgents).toBe("number");
    expect(typeof body.stats.activeAgents).toBe("number");
    expect(Array.isArray(body.transactions)).toBe(true);
  });
});

describe("GET /api/services", () => {
  it("returns paginated services", async () => {
    const res = await api("/api/services");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("supports category filter", async () => {
    const res = await api("/api/services?category=Development");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/dashboard", () => {
  it("requires wallet parameter", async () => {
    const res = await api("/api/dashboard");
    expect(res.status).toBe(400);
  });

  it("returns dashboard for valid wallet", async () => {
    const res = await api("/api/dashboard?wallet=0xE2E_PATRON");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats).toBeDefined();
    expect(body.approvals).toBeDefined();
    expect(body.activities).toBeDefined();
    expect(body.agents).toBeDefined();
  });
});

describe("GET /api/talos — pagination", () => {
  it("returns paginated data with nextCursor", async () => {
    const res = await api("/api/talos?limit=1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeLessThanOrEqual(1);
    // nextCursor may or may not exist depending on total count
    if (body.data.length === 1) {
      expect(typeof body.nextCursor).toBe("string");
    }
  });
});

// ────────────────────────────────────────────
// 8. Full lifecycle verification
// ────────────────────────────────────────────

describe("Full lifecycle — verify talos detail reflects all writes", () => {
  it("detail endpoint shows activity, approval, and revenue", async () => {
    const res = await api(`/api/talos/${talosId}`);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Activity we created
    expect(body.activities.length).toBeGreaterThanOrEqual(1);
    const activity = body.activities.find(
      (a: { content: string }) => a.content === "E2E test post on X"
    );
    expect(activity).toBeDefined();

    // Approval we created and approved
    expect(body.approvals.length).toBeGreaterThanOrEqual(1);
    const approval = body.approvals.find(
      (a: { id: string }) => a.id === approvalId
    );
    expect(approval).toBeDefined();
    expect(approval.status).toBe("approved");

    // Revenue we recorded
    expect(body.revenues.length).toBeGreaterThanOrEqual(1);
    const revenue = body.revenues.find(
      (r: { txHash: string | null }) => r.txHash === "0xE2E_TEST_TX"
    );
    expect(revenue).toBeDefined();
  });
});
