import { describe, it, expect, vi, beforeEach } from "vitest";
import { TalosClient, TalosAPIError } from "../src/client.js";
import {
  TalosEventStream,
  TalosStreamError,
} from "../src/events.js";
import { TalosWebhook, TalosWebhookError, ReplayStore } from "../src/webhooks.js";
import {
  ChaosInjector,
  ChaosInjectedError,
  FaultType,
} from "../src/chaos.js";

const alwaysInject = () => 0;
const neverInject = () => 1;

function makeDeterministicInjector(
  faults: { type: FaultType; probability: number; durationMs?: number }[],
  random: () => number = alwaysInject,
): ChaosInjector {
  const injector = new ChaosInjector({ random });
  for (const f of faults) {
    injector.registerFault({
      type: f.type,
      probability: f.probability,
      durationMs: f.durationMs,
    });
  }
  return injector;
}

describe("Chaos Integration - TalosClient Production Request Paths", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("request() method (used by listTaloses, getTalos, createTalos, etc.)", () => {
    it("should inject NETWORK_DROP fault (prob 1.0) via TalosClient before fetch is called", async () => {
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DROP, probability: 1.0 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "test",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });

      await expect(client.getTalos("talos-1")).rejects.toThrow(ChaosInjectedError);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(chaos.injectionCount).toBe(1);
      expect(chaos.injectionHistory[0].type).toBe(FaultType.NETWORK_DROP);
    });

    it("should inject API_TIMEOUT fault and throw ChaosInjectedError", async () => {
      vi.useFakeTimers();
      const chaos = makeDeterministicInjector([
        { type: FaultType.API_TIMEOUT, probability: 1.0, durationMs: 100 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });

      const rejection = expect(client.getTalos("talos-1")).rejects.toThrow(
        ChaosInjectedError,
      );
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect((chaos.injectionHistory[0].config as any).durationMs).toBe(100);
      vi.useRealTimers();
    });

    it("should inject NETWORK_DELAY fault (prob 1.0) then proceed to call fetch successfully", async () => {
      vi.useFakeTimers();
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DELAY, probability: 1.0, durationMs: 500 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1, jitter: false },
      });
      const mockData = { id: "talos-1", name: "Test" };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const promise = client.getTalos("talos-1");
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      vi.useRealTimers();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockData);
      expect(chaos.injectionCount).toBe(1);
    });

    it("should NOT inject any fault when chaos injector has no matching faults registered", async () => {
      const chaos = makeDeterministicInjector([]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });
      const mockData = { id: "talos-1", name: "No-Chaos" };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await client.getTalos("talos-1");

      expect(result).toEqual(mockData);
      expect(chaos.injectionCount).toBe(0);
    });

    it("should NOT inject when probability is 0 (deterministic)", async () => {
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DROP, probability: 0 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });
      const mockData = { id: "talos-1" };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await client.getTalos("talos-1");

      expect(result).toEqual(mockData);
      expect(chaos.injectionCount).toBe(0);
    });

    it("should work through the listTaloses paginated path too", async () => {
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DROP, probability: 1.0 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });

      await expect(
        client.listTaloses({ limit: 10 }),
      ).rejects.toThrow(ChaosInjectedError);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("should work through the createTalos POST path", async () => {
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DROP, probability: 1.0 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        chaosInjector: chaos,
        retryPolicy: { maxAttempts: 1 },
      });

      await expect(
        client.createTalos({ name: "N", category: "C", description: "D" }),
      ).rejects.toThrow(ChaosInjectedError);
    });
  });

  describe("purchaseServiceWithPayment() x402 flow (direct fetch path)", () => {
    it("should inject NETWORK_DROP fault before the initial x402 fetch call", async () => {
      const chaos = makeDeterministicInjector([
        { type: FaultType.NETWORK_DROP, probability: 1.0 },
      ]);
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "test",
        chaosInjector: chaos,
      });

      await expect(
        client.purchaseServiceWithPayment("provider", "buyer", { foo: "bar" }),
      ).rejects.toThrow(ChaosInjectedError);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(chaos.injectionCount).toBe(1);
    });

    it("should allow the flow to proceed when no fault fires", async () => {
      const chaos = makeDeterministicInjector(
        [{ type: FaultType.NETWORK_DROP, probability: 0 }],
        neverInject,
      );
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "test",
        chaosInjector: chaos,
      });
      const mockData = { id: "talos-1" };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => mockData,
      } as Response);

      const result = await client.purchaseServiceWithPayment(
        "provider",
        "buyer",
        { foo: "bar" },
      );
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Chaos Integration - TalosEventStream SSE Production Path", () => {
  it("should inject NETWORK_DROP fault before fetch in _openConnection", async () => {
    const chaos = makeDeterministicInjector([
      { type: FaultType.NETWORK_DROP, probability: 1.0 },
    ]);
    const errorEvents: unknown[] = [];
    const stream = new TalosEventStream("http://localhost:3000", {
      maxReconnectAttempts: 0,
      chaosInjector: chaos,
    });
    stream.on("error", (err) => errorEvents.push(err));

    stream.connect();
    await new Promise((r) => setTimeout(r, 10));

    expect(chaos.injectionCount).toBeGreaterThanOrEqual(1);
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0]).toBeInstanceOf(ChaosInjectedError);
    stream.close();
  });

  it("should proceed with fetch call when no fault registered", async () => {
    const chaos = makeDeterministicInjector([], neverInject);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          controller.close();
        },
      }),
    } as unknown as Response);

    const stream = new TalosEventStream("http://localhost:3000", {
      fetch: mockFetch,
      maxReconnectAttempts: 0,
      heartbeatIntervalMs: 0,
      chaosInjector: chaos,
    });

    stream.connect();
    await new Promise((r) => setTimeout(r, 20));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(chaos.injectionCount).toBe(0);
    stream.close();
  });
});

describe("Chaos Integration - TalosWebhook.verify() Production Path", () => {
  const VALID_SECRET = "whsec_testsecret";
  const VALID_PAYLOAD = JSON.stringify({ event: "test", id: "evt_123" });

  async function makeValidSignature(
    timestamp: number,
    payload: string,
    secret: string,
  ): Promise<string> {
    const enc = new TextEncoder();
    const signedContent = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedContent));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t=${timestamp},v1=${hex}`;
  }

  describe("SIGNATURE_VERIFICATION_SLOW fault", () => {
    it("should inject SIGNATURE_VERIFICATION_SLOW delay before HMAC verification", async () => {
      vi.useFakeTimers();
      const now = Math.floor(Date.now() / 1000);
      const sigHeader = await makeValidSignature(now, VALID_PAYLOAD, VALID_SECRET);
      const chaos = makeDeterministicInjector([
        {
          type: FaultType.SIGNATURE_VERIFICATION_SLOW,
          probability: 1.0,
          durationMs: 1000,
        },
      ]);

      const promise = TalosWebhook.verify({
        payload: VALID_PAYLOAD,
        signatureHeader: sigHeader,
        secret: VALID_SECRET,
        toleranceSeconds: 999999,
        chaosInjector: chaos,
      });

      await vi.advanceTimersByTimeAsync(999);
      const status = await Promise.race([
        promise.then(() => "resolved" as const),
        Promise.resolve("pending" as const),
      ]);
      expect(status).toBe("pending");

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toBeUndefined();
      vi.useRealTimers();
      expect(chaos.injectionCount).toBe(1);
    });
  });

  describe("REPLAY_STORE_ERROR fault", () => {
    it("should inject REPLAY_STORE_ERROR before replayStore.has() call", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sigHeader = await makeValidSignature(now, VALID_PAYLOAD, VALID_SECRET);
      const chaos = makeDeterministicInjector([
        { type: FaultType.REPLAY_STORE_ERROR, probability: 1.0 },
      ]);
      const fakeStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };

      await expect(
        TalosWebhook.verify({
          payload: VALID_PAYLOAD,
          signatureHeader: sigHeader,
          secret: VALID_SECRET,
          toleranceSeconds: 999999,
          replayStore: fakeStore,
          eventId: "evt_123",
          chaosInjector: chaos,
        }),
      ).rejects.toThrow(TalosWebhookError);

      expect(fakeStore.has).not.toHaveBeenCalled();
      expect(chaos.injectionCount).toBe(1);
      const hist = chaos.injectionHistory[0];
      expect(hist.type).toBe(FaultType.REPLAY_STORE_ERROR);
    });

    it("should inject REPLAY_STORE_ERROR before replayStore.set() call (after has() succeeds)", async () => {
      let callCount = 0;
      const alternateRandom = () => {
        callCount++;
        return callCount === 1 ? 1 : 0;
      };
      const now = Math.floor(Date.now() / 1000);
      const sigHeader = await makeValidSignature(now, VALID_PAYLOAD, VALID_SECRET);
      const chaos = new ChaosInjector({ random: alternateRandom });
      chaos.registerFault({
        type: FaultType.REPLAY_STORE_ERROR,
        probability: 0.5,
      });
      const fakeStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };

      await expect(
        TalosWebhook.verify({
          payload: VALID_PAYLOAD,
          signatureHeader: sigHeader,
          secret: VALID_SECRET,
          toleranceSeconds: 999999,
          replayStore: fakeStore,
          eventId: "evt_123",
          chaosInjector: chaos,
        }),
      ).rejects.toThrow(TalosWebhookError);

      expect(fakeStore.has).toHaveBeenCalledWith("evt_123");
      expect(fakeStore.set).not.toHaveBeenCalled();
      expect(chaos.injectionCount).toBe(1);
    });

    it("should proceed through verify cleanly when probability = 0", async () => {
      const now = Math.floor(Date.now() / 1000);
      const sigHeader = await makeValidSignature(now, VALID_PAYLOAD, VALID_SECRET);
      const chaos = makeDeterministicInjector(
        [
          { type: FaultType.SIGNATURE_VERIFICATION_SLOW, probability: 0 },
          { type: FaultType.REPLAY_STORE_ERROR, probability: 0 },
        ],
        neverInject,
      );
      const fakeStore: ReplayStore = {
        has: vi.fn().mockResolvedValue(false),
        set: vi.fn().mockResolvedValue(undefined),
      };

      await expect(
        TalosWebhook.verify({
          payload: VALID_PAYLOAD,
          signatureHeader: sigHeader,
          secret: VALID_SECRET,
          toleranceSeconds: 999999,
          replayStore: fakeStore,
          eventId: "evt_123",
          chaosInjector: chaos,
        }),
      ).resolves.toBeUndefined();

      expect(fakeStore.has).toHaveBeenCalledTimes(1);
      expect(fakeStore.set).toHaveBeenCalledTimes(1);
      expect(chaos.injectionCount).toBe(0);
    });
  });
});
