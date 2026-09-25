import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_USDC_ISSUERS } from "../src/lib/stellar-config";

// Route modules only need these at import time; nothing here touches a DB.
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/fulfillment", () => ({ fulfillInstant: vi.fn() }));
vi.mock("@/lib/reputation-ledger", () => ({ ingestJobToLedger: vi.fn() }));

// Routes that build USDC payments from USDC_ISSUER.
const PAYMENT_ROUTES = [
  ["POST /api/talos/:id/jobs", () => import("../src/app/api/talos/[id]/jobs/route")],
  [
    "POST /api/talos/:id/revenue/distribute",
    () => import("../src/app/api/talos/[id]/revenue/distribute/route"),
  ],
] as const;

function stubStellarEnv(env: {
  network?: string;
  publicNetwork?: string;
  issuer?: string;
}) {
  vi.stubEnv("STELLAR_NETWORK", env.network ?? "");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", env.publicNetwork ?? "");
  vi.stubEnv("STELLAR_USDC_ISSUER", env.issuer ?? "");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_USDC_ISSUER", "");
  vi.resetModules();
}

describe("payment routes honour Stellar asset config validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe.each(PAYMENT_ROUTES)("%s", (_name, load) => {
    it("loads with the default testnet configuration", async () => {
      stubStellarEnv({});
      const mod = await load();
      expect(typeof mod.POST).toBe("function");
    });

    it("loads with a matching mainnet pair", async () => {
      stubStellarEnv({ network: "mainnet", issuer: CANONICAL_USDC_ISSUERS.mainnet });
      const mod = await load();
      expect(typeof mod.POST).toBe("function");
    });

    it("refuses to load with the testnet issuer on mainnet", async () => {
      stubStellarEnv({ network: "mainnet", issuer: CANONICAL_USDC_ISSUERS.testnet });
      await expect(load()).rejects.toThrow(/issuer_network_mismatch/);
    });

    it("refuses to load when server and browser networks disagree", async () => {
      stubStellarEnv({ network: "testnet", publicNetwork: "mainnet" });
      await expect(load()).rejects.toThrow(/network_conflict/);
    });

    it("refuses to load with a malformed issuer and does not leak it", async () => {
      const malformed = "SBADSEEDVALUETHATSHOULDNEVERBELOGGEDORRETURNED0000000000";
      stubStellarEnv({ issuer: malformed });
      const error = await load().then(
        () => undefined,
        (err: unknown) => err as Error,
      );
      expect(error?.message).toMatch(/invalid_issuer/);
      expect(error?.message).not.toContain(malformed);
    });
  });
});
