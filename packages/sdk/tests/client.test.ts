import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient } from "../src/client.js";

describe("TalosClient", () => {
  const client = new TalosClient({ baseUrl: "http://localhost:3000", apiKey: "test-key" });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("should list taloses", async () => {
    const mockData = { data: [{ id: "1", name: "Talos 1" }], nextCursor: null };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.listTaloses({ limit: 10 });

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos?limit=10", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  it("should get talos detail", async () => {
    const mockData = { id: "1", name: "Talos 1" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.getTalos("1");

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos/1", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  it("should create talos", async () => {
    const params = { name: "New Talos", category: "Test", description: "Desc" };
    const mockData = { id: "2", ...params, apiKeyOnce: "new-key" };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await client.createTalos(params);

    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/talos", expect.objectContaining({
      method: "POST",
      body: JSON.stringify(params),
    }));
    expect(result).toEqual(mockData);
  });

  it("should handle x402 flow in purchaseServiceWithPayment", async () => {
    // 1st call: 402 challenge
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 402,
      ok: false,
      headers: new Headers({
        "WWW-Authenticate": 'x402 price="0.50", payee="GABC", token="USDC", network="stellar:testnet"',
      }),
    } as Response);

    // 2nd call: signPayment (internal called by purchaseServiceWithPayment)
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ paymentHeader: "signed-header" }),
    } as Response);

    // 3rd call: actual purchase with header
    const mockJob = { id: "job-1", status: "pending" };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockJob,
    } as Response);

    const result = await client.purchaseServiceWithPayment("provider-id", "buyer-id", { foo: "bar" });

    expect(result).toEqual(mockJob);
    expect(fetch).toHaveBeenCalledTimes(3);

    // Check sign call
    expect(fetch).toHaveBeenNthCalledWith(2, "http://localhost:3000/api/talos/buyer-id/sign", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ payee: "GABC", amount: 0.5, assetCode: "USDC" }),
    }));

    // Check final purchase call
    expect(fetch).toHaveBeenNthCalledWith(3, "http://localhost:3000/api/talos/provider-id/service", expect.objectContaining({
      headers: expect.objectContaining({ "X-PAYMENT": "signed-header" }),
    }));
  });

  it("should throw TalosAPIError on failure", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Error",
    } as Response);

    await expect(client.getTalos("1")).rejects.toThrow("Talos API error 500 on /api/talos/1: Internal Error");
  });
});
