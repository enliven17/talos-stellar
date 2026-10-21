/**
 * Unit tests for RegistryReader and NameServiceReader.
 *
 * All tests use recorded (stubbed) `simulateTransaction` responses — no live
 * Soroban RPC calls are made. The stubs mirror the shape that
 * `@stellar/stellar-sdk` `rpc.Server.simulateTransaction` returns for
 * successful reads and error cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RegistryReader,
  NameServiceReader,
  TESTNET_REGISTRY_CONTRACT_ID,
  TESTNET_NAME_SERVICE_CONTRACT_ID,
  TESTNET_RPC_URL,
  TESTNET_NETWORK_PASSPHRASE,
} from "../src/contracts.js";
import {
  TalosContractSimulateError,
  TalosContractError,
} from "../src/errors.js";
import { rpc, xdr, nativeToScVal, Address } from "@stellar/stellar-sdk";

// ── Fixture helpers ────────────────────────────────────────────────────────

/**
 * Build a minimal SimulateTransactionSuccessResponse carrying a given
 * ScVal as the return value. We encode a native JS value back to ScVal so the
 * `scValToNative` call inside the reader round-trips cleanly.
 */
function successResponse(
  retval: xdr.ScVal,
): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    id: "fixture-id",
    latestLedger: 1000,
    minResourceFee: "100",
    cost: { cpuInsns: "100", memBytes: "100" },
    result: {
      auth: [],
      retval,
    },
    transactionData: "" as unknown as xdr.SorobanTransactionData,
    events: [],
    restorePreamble: undefined,
  };
}

/**
 * Build a SimulateTransactionErrorResponse that the reader should translate
 * into a TalosContractSimulateError.
 */
function errorResponse(msg: string): rpc.Api.SimulateTransactionErrorResponse {
  return {
    id: "fixture-error",
    latestLedger: 1000,
    error: msg,
    events: [],
  };
}

/**
 * Encode a raw native value as an ScVal via `nativeToScVal` so the test
 * fixture matches exactly what the on-chain contract would return.
 */
function scVal(native: unknown): xdr.ScVal {
  return nativeToScVal(native as Parameters<typeof nativeToScVal>[0]);
}

// ── Recorded fixture data ──────────────────────────────────────────────────

/** Recorded Talos struct fixture for talos_id = 1 (Vega). */
const FIXTURE_TALOS_NATIVE = {
  id: 1,
  name: "Vega",
  category: "commerce",
  description: "Autonomous commerce agent for the Talos Protocol.",
  creator: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
  patron: {
    creator_share: 50,
    investor_share: 30,
    treasury_share: 20,
    creator_addr: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
    investor_addr: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
    treasury_addr: "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
  },
  kernel: {
    approval_threshold: 1000n,
    gtm_budget: 5000n,
    min_patron_pulse: 100n,
  },
  pulse: {
    total_supply: 1000000n,
    price_usd_cents: 100n,
    token_symbol: "VEGA",
  },
  created_at: 1700000000n,
  active: true,
};

// ── Mock setup ─────────────────────────────────────────────────────────────

function mockServer(
  fixture: rpc.Api.SimulateTransactionResponse,
): rpc.Server {
  const mock = {
    simulateTransaction: vi.fn().mockResolvedValue(fixture),
  } as unknown as rpc.Server;
  return mock;
}

// ── RegistryReader tests ───────────────────────────────────────────────────

describe("RegistryReader", () => {
  describe("constructor defaults", () => {
    it("uses testnet RPC URL and contract ID by default", () => {
      const reader = new RegistryReader();
      // The internal _server and _contract are private, but we can assert
      // exports match expectations.
      expect(TESTNET_REGISTRY_CONTRACT_ID).toBe(
        "CAMLL62EVCRV5CEHBO34MHUAHI5FJE5XFVAU57VZEAVY2EE5Q36FVHUX",
      );
      expect(TESTNET_RPC_URL).toBe("https://soroban-testnet.stellar.org");
      expect(reader).toBeInstanceOf(RegistryReader);
    });

    it("accepts custom rpcUrl and contractId options", () => {
      const reader = new RegistryReader({
        rpcUrl: "http://localhost:8000",
        contractId: "CAMLL62EVCRV5CEHBO34MHUAHI5FJE5XFVAU57VZEAVY2EE5Q36FVHUX",
      });
      expect(reader).toBeInstanceOf(RegistryReader);
    });
  });

  describe("getTalos", () => {
    it("returns a decoded OnChainTalos for a known talos_id", async () => {
      const reader = new RegistryReader();
      // Inject mock server via object replacement (accessing private for test)
      const srv = mockServer(successResponse(scVal(FIXTURE_TALOS_NATIVE)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.getTalos(1);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.name).toBe("Vega");
      expect(result!.category).toBe("commerce");
      expect(result!.active).toBe(true);
      expect(result!.creator).toBe(
        "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL",
      );
      expect(typeof result!.createdAt).toBe("bigint");
    });

    it("returns null when the contract returns Option::None (undefined)", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(xdr.ScVal.scvVoid()));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.getTalos(99999);
      expect(result).toBeNull();
    });

    it("decodes nested Patron fields correctly", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(FIXTURE_TALOS_NATIVE)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.getTalos(1);
      expect(result!.patron.creatorShare).toBe(50);
      expect(result!.patron.investorShare).toBe(30);
      expect(result!.patron.treasuryShare).toBe(20);
    });

    it("decodes nested Kernel and Pulse fields as bigint", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(FIXTURE_TALOS_NATIVE)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.getTalos(1);
      expect(result!.kernel.approvalThreshold).toBe(1000n);
      expect(result!.pulse.totalSupply).toBe(1000000n);
      expect(result!.pulse.tokenSymbol).toBe("VEGA");
    });

    it("throws TalosContractSimulateError on RPC error response", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(errorResponse("contract vm trap: EntryNotFound"));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      await expect(reader.getTalos(1)).rejects.toBeInstanceOf(
        TalosContractSimulateError,
      );
    });

    it("TalosContractSimulateError is instanceof TalosContractError", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(errorResponse("rpc error"));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      try {
        await reader.getTalos(1);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(TalosContractError);
        expect(err).toBeInstanceOf(TalosContractSimulateError);
      }
    });
  });

  describe("creatorOf", () => {
    it("returns a G… address string for a known talos_id", async () => {
      const addr = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(addr)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.creatorOf(1);
      expect(result).toBe(addr);
    });

    it("returns null when talos_id does not exist", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(xdr.ScVal.scvVoid()));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const result = await reader.creatorOf(99999);
      expect(result).toBeNull();
    });
  });

  describe("isActive", () => {
    it("returns true for an active talos", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(true)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      expect(await reader.isActive(1)).toBe(true);
    });

    it("returns false for an inactive talos", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(false)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      expect(await reader.isActive(99)).toBe(false);
    });
  });

  describe("version", () => {
    it("returns a ContractVersion triple", async () => {
      const reader = new RegistryReader();
      // Soroban tuple → native array
      const srv = mockServer(successResponse(scVal([1, 1, 0])));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      const v = await reader.version();
      expect(v.major).toBe(1);
      expect(v.minor).toBe(1);
      expect(v.patch).toBe(0);
    });
  });

  describe("nextTalosId", () => {
    it("returns a number", async () => {
      const reader = new RegistryReader();
      const srv = mockServer(successResponse(scVal(7)));
      (reader as unknown as { _server: rpc.Server })._server = srv;

      expect(await reader.nextTalosId()).toBe(7);
    });
  });
});

// ── NameServiceReader tests ────────────────────────────────────────────────

describe("NameServiceReader", () => {
  describe("constructor defaults", () => {
    it("uses testnet name service contract ID by default", () => {
      expect(TESTNET_NAME_SERVICE_CONTRACT_ID).toBe(
        "CAP32WBDUMF4UOXLSCHQDM3MDKS4WNQUQAB4WMAGUXTXJNQ4OWD3CQXF",
      );
    });
  });

  describe("resolveName", () => {
    it("returns a numeric Talos ID for a known name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal(1)));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.resolveName("vega")).toBe(1);
    });

    it("returns null for an unregistered name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(xdr.ScVal.scvVoid()));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.resolveName("no-such-name")).toBeNull();
    });

    it("throws TalosContractSimulateError on RPC error", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(errorResponse("HostError: general error"));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      await expect(ns.resolveName("vega")).rejects.toBeInstanceOf(
        TalosContractSimulateError,
      );
    });
  });

  describe("nameOf", () => {
    it("returns the registered name for a known talos_id", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal("vega")));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.nameOf(1)).toBe("vega");
    });

    it("returns null when talos has no name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(xdr.ScVal.scvVoid()));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.nameOf(42)).toBeNull();
    });
  });

  describe("isNameAvailable", () => {
    it("returns true for an available name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal(true)));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.isNameAvailable("brand-new-name")).toBe(true);
    });

    it("returns false for a taken name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal(false)));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.isNameAvailable("vega")).toBe(false);
    });
  });

  describe("hasName", () => {
    it("returns true when talos has a registered name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal(true)));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.hasName(1)).toBe(true);
    });

    it("returns false when talos has no name", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal(false)));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      expect(await ns.hasName(99)).toBe(false);
    });
  });

  describe("version", () => {
    it("returns a ContractVersion triple", async () => {
      const ns = new NameServiceReader();
      const srv = mockServer(successResponse(scVal([1, 1, 0])));
      (ns as unknown as { _server: rpc.Server })._server = srv;

      const v = await ns.version();
      expect(v.major).toBe(1);
      expect(v.minor).toBe(1);
      expect(v.patch).toBe(0);
    });
  });
});

// ── Export-map coverage check ──────────────────────────────────────────────

describe("Export map — contracts re-exported from index", () => {
  it("RegistryReader is exported from the SDK index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.RegistryReader).toBe("function");
  });

  it("NameServiceReader is exported from the SDK index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.NameServiceReader).toBe("function");
  });

  it("TalosContractError is exported from the SDK index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.TalosContractError).toBe("function");
  });

  it("TalosContractSimulateError is exported from the SDK index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.TalosContractSimulateError).toBe("function");
  });

  it("TESTNET_REGISTRY_CONTRACT_ID is exported from the SDK index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.TESTNET_REGISTRY_CONTRACT_ID).toBe("string");
    expect(mod.TESTNET_REGISTRY_CONTRACT_ID).toMatch(/^C[A-Z2-7]{55}$/);
  });
});
