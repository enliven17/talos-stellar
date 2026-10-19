import { describe, expect, it, vi } from "vitest";
import { TalosClient } from "../src/client.js";
import { TalosNotFoundError } from "../src/errors.js";
import { isTerminalPaymentFinality } from "../src/types.js";
import type {
  RegisteredJobPaymentStatus,
  UnregisteredJobPaymentStatus,
} from "../src/types.js";

describe("TalosClient.getJobPaymentStatus", () => {
  const baseUrl = "http://localhost:3000";

  it("returns the registered response as-is", async () => {
    const response: RegisteredJobPaymentStatus = {
      jobId: "job-1",
      txHash: "stellar-tx-hash",
      finalityStatus: "CONFIRMING",
      confirmedLedger: null,
      lastLedgerChecked: 123,
      pollCount: 2,
      lastError: null,
      repairApplied: false,
      updatedAt: "2026-10-18T12:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => response,
    } as Response);
    const client = new TalosClient({ baseUrl, fetch });

    await expect(client.getJobPaymentStatus("talos-1", "job-1")).resolves.toEqual(response);
  });

  it("returns the unregistered response as-is", async () => {
    const response: UnregisteredJobPaymentStatus = {
      jobId: "job-1",
      txHash: null,
      finalityStatus: null,
      registered: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => response,
    } as Response);
    const client = new TalosClient({ baseUrl, fetch });

    await expect(client.getJobPaymentStatus("talos-1", "job-1")).resolves.toEqual(response);
  });

  it("URL-encodes each path segment", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const client = new TalosClient({ baseUrl, fetch });

    await client.getJobPaymentStatus("talos/one space", "job?two");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/talos/talos%2Fone%20space/jobs/job%3Ftwo/payment-status",
      expect.any(Object),
    );
  });

  it("surfaces a 404 as TalosNotFoundError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Job not found",
      headers: new Headers(),
    } as Response);
    const client = new TalosClient({ baseUrl, fetch });

    await expect(client.getJobPaymentStatus("talos-1", "missing-job")).rejects.toBeInstanceOf(TalosNotFoundError);
  });
});

describe("isTerminalPaymentFinality", () => {
  it.each(["CONFIRMED", "FAILED", "EXPIRED", "NOT_FOUND"] as const)("treats %s as terminal", (status) => {
    expect(isTerminalPaymentFinality(status)).toBe(true);
  });

  it.each(["PENDING", "CONFIRMING"] as const)("treats %s as nonterminal", (status) => {
    expect(isTerminalPaymentFinality(status)).toBe(false);
  });
});