import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    talos: [] as Record<string, unknown>[],
    services: [] as Record<string, unknown>[],
    jobs: [] as Record<string, unknown>[],
  };
  const tableOf = (t: unknown) => {
    if (t === tableRefs.tlsTalos) return state.talos;
    if (t === tableRefs.tlsCommerceServices) return state.services;
    if (t === tableRefs.tlsCommerceJobs) return state.jobs;
    return [];
  };
  const tableRefs = {
    tlsTalos: { __table: "talos" },
    tlsCommerceServices: { __table: "services" },
    tlsCommerceJobs: { __table: "jobs" },
  };

  const matches = (row: Record<string, unknown>, cond: unknown): boolean => {
    if (!cond) return true;
    const c = cond as { __pred?: (r: Record<string, unknown>) => boolean };
    return c.__pred ? c.__pred(row) : true;
  };

  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        const rows = () => tableOf(table);
        let cond: unknown;
        const builder: Record<string, unknown> = {
          where: (c: unknown) => {
            cond = c;
            return builder;
          },
          limit: () => builder,
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(rows().filter((r) => matches(r, cond))).then(resolve, reject),
        };
        return builder;
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          for (const row of tableOf(table)) {
            if (matches(row, cond)) Object.assign(row, values);
          }
          return Promise.resolve();
        },
      }),
    })),
  };

  return { state, db, tableRefs };
});

vi.mock("@/db", () => ({ db: dbMock.db }));
vi.mock("@/db/schema", () => ({
  tlsTalos: dbMock.tableRefs.tlsTalos,
  tlsCommerceServices: dbMock.tableRefs.tlsCommerceServices,
  tlsCommerceJobs: dbMock.tableRefs.tlsCommerceJobs,
}));
vi.mock("drizzle-orm", () => {
  const pred = (fn: (r: Record<string, unknown>) => boolean) => ({ __pred: fn });
  const col = (name: string) => name;
  return {
    eq: (field: string, value: unknown) =>
      pred((r) => r[field] === value),
    and: (...conds: { __pred: (r: Record<string, unknown>) => boolean }[]) =>
      pred((r) => conds.every((c) => c.__pred(r))),
    isNull: (field: string) => pred((r) => r[field] === null || r[field] === undefined),
    _col: col,
  };
});
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/stellar", () => ({
  createAgentKeypair: vi.fn(async () => ({ publicKey: "GNEWKEY", secretKey: "SSECRET" })),
}));

import { databaseEffects } from "@/lib/governance/effects";
import type { StepContext } from "@/lib/governance/provisioning";

const TALOS = "talos-1";

function ctx(outputs: Record<string, any> = {}): StepContext {
  return { talosId: TALOS, jobId: "job-1", outputs } as unknown as StepContext;
}

function resetState() {
  dbMock.state.talos.length = 0;
  dbMock.state.services.length = 0;
  dbMock.state.jobs.length = 0;
  dbMock.state.talos.push({
    id: TALOS,
    agentWalletId: null,
    agentWalletAddress: null,
    apiKey: null,
    agentOnline: false,
    status: "Paused",
  });
}

describe("databaseEffects.createWallet", () => {
  beforeEach(resetState);

  it("allocates a wallet when none exists", async () => {
    const out = await databaseEffects.createWallet!(ctx());
    expect(out).toEqual({ walletPublicKey: "GNEWKEY", reused: false });
    expect(dbMock.state.talos[0].agentWalletId).toBe("GNEWKEY");
    expect(dbMock.state.talos[0].agentWalletAddress).toBe("GNEWKEY");
  });

  it("is idempotent: reuses an existing wallet without minting again", async () => {
    dbMock.state.talos[0].agentWalletId = "GEXISTING";
    const { createAgentKeypair } = await import("@/lib/stellar");
    const spy = vi.mocked(createAgentKeypair);
    spy.mockClear();
    const out = await databaseEffects.createWallet!(ctx());
    expect(out).toEqual({ walletPublicKey: "GEXISTING", reused: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when the agent does not exist", async () => {
    dbMock.state.talos.length = 0;
    await expect(databaseEffects.createWallet!(ctx())).rejects.toThrow("agent not found");
  });
});

describe("databaseEffects.releaseWallet", () => {
  beforeEach(resetState);

  it("unlinks the wallet from the agent record", async () => {
    dbMock.state.talos[0].agentWalletId = "GX";
    dbMock.state.talos[0].agentWalletAddress = "GX";
    await databaseEffects.releaseWallet!(ctx());
    expect(dbMock.state.talos[0].agentWalletId).toBeNull();
    expect(dbMock.state.talos[0].agentWalletAddress).toBeNull();
  });

  it("is safe to call twice", async () => {
    await databaseEffects.releaseWallet!(ctx());
    await databaseEffects.releaseWallet!(ctx());
    expect(dbMock.state.talos[0].agentWalletId).toBeNull();
  });
});

describe("databaseEffects.issueCredentials", () => {
  beforeEach(resetState);

  it("mints an API key and never returns its value", async () => {
    const out = await databaseEffects.issueCredentials!(ctx());
    expect(out).toEqual({ credentialIssued: true, reused: false });
    expect(String(dbMock.state.talos[0].apiKey)).toMatch(/^tak_[0-9a-f]{48}$/);
    expect(JSON.stringify(out)).not.toContain("tak_");
  });

  it("is idempotent: an existing key is reused, not replaced", async () => {
    dbMock.state.talos[0].apiKey = "tak_existing";
    const out = await databaseEffects.issueCredentials!(ctx());
    expect(out).toEqual({ credentialIssued: true, reused: true });
    expect(dbMock.state.talos[0].apiKey).toBe("tak_existing");
  });

  it("throws when the agent does not exist", async () => {
    dbMock.state.talos.length = 0;
    await expect(databaseEffects.issueCredentials!(ctx())).rejects.toThrow("agent not found");
  });
});

describe("databaseEffects.revokeCredentials", () => {
  beforeEach(resetState);

  it("clears the API key", async () => {
    dbMock.state.talos[0].apiKey = "tak_x";
    await databaseEffects.revokeCredentials!(ctx());
    expect(dbMock.state.talos[0].apiKey).toBeNull();
  });
});

describe("databaseEffects.registerServices / deregisterServices", () => {
  beforeEach(() => {
    resetState();
    dbMock.state.services.push(
      { id: "s1", talosId: TALOS, stellarPublicKey: "GOLD1" },
      { id: "s2", talosId: TALOS, stellarPublicKey: null },
    );
  });

  it("routes services to the wallet and records previous keys", async () => {
    const out = await databaseEffects.registerServices!(
      ctx({ wallet: { walletPublicKey: "GNEW" } }),
    );
    expect(out).toEqual({
      serviceCount: 2,
      previousKeys: [
        { id: "s1", stellarPublicKey: "GOLD1" },
        { id: "s2", stellarPublicKey: null },
      ],
    });
    expect(dbMock.state.services.every((s) => s.stellarPublicKey === "GNEW")).toBe(true);
  });

  it("fails when the wallet step produced no key", async () => {
    await expect(databaseEffects.registerServices!(ctx({}))).rejects.toThrow(
      "wallet step produced no public key",
    );
    await expect(
      databaseEffects.registerServices!(ctx({ wallet: { walletPublicKey: "" } })),
    ).rejects.toThrow("wallet step produced no public key");
  });

  it("deregister restores each service's exact prior key", async () => {
    const previous = [
      { id: "s1", stellarPublicKey: "GOLD1" },
      { id: "s2", stellarPublicKey: null },
    ];
    await databaseEffects.registerServices!(ctx({ wallet: { walletPublicKey: "GNEW" } }));
    await databaseEffects.deregisterServices!(ctx({ services: { previousKeys: previous } }));
    expect(dbMock.state.services.find((s) => s.id === "s1")!.stellarPublicKey).toBe("GOLD1");
    expect(dbMock.state.services.find((s) => s.id === "s2")!.stellarPublicKey).toBeNull();
  });

  it("deregister is a no-op without recorded previous keys", async () => {
    await databaseEffects.deregisterServices!(ctx({}));
    expect(dbMock.state.services.find((s) => s.id === "s1")!.stellarPublicKey).toBe("GOLD1");
  });
});

describe("databaseEffects.startRuntime / stopRuntime", () => {
  beforeEach(() => {
    resetState();
    dbMock.state.jobs.push(
      { id: "j1", talosId: TALOS, status: "pending", leasedBy: "w", leasedAt: 1, leaseExpiresAt: 2 },
      { id: "j2", talosId: TALOS, status: "running", leasedBy: "w", leasedAt: 1, leaseExpiresAt: 2 },
      { id: "j3", talosId: "other", status: "pending", leasedBy: null, leasedAt: null, leaseExpiresAt: null },
    );
  });

  it("startRuntime brings the agent online and active", async () => {
    const out = await databaseEffects.startRuntime!(ctx());
    expect(out).toEqual({ online: true });
    expect(dbMock.state.talos[0]).toMatchObject({ status: "Active", agentOnline: true });
    expect(dbMock.state.talos[0].agentLastSeen).toBeInstanceOf(Date);
  });

  it("stopRuntime takes the agent offline", async () => {
    dbMock.state.talos[0].agentOnline = true;
    await databaseEffects.stopRuntime!(ctx());
    expect(dbMock.state.talos[0].agentOnline).toBe(false);
  });

  it("stopRuntime cancels only this agent's pending jobs, leaving in-flight leases alone", async () => {
    await databaseEffects.stopRuntime!(ctx());
    expect(dbMock.state.jobs.find((j) => j.id === "j1")).toMatchObject({
      status: "cancelled",
      leasedBy: null,
      leasedAt: null,
      leaseExpiresAt: null,
    });
    expect(dbMock.state.jobs.find((j) => j.id === "j2")!.status).toBe("running");
    expect(dbMock.state.jobs.find((j) => j.id === "j3")!.status).toBe("pending");
  });
});
