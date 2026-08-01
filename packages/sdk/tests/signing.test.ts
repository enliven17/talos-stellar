import { describe, expect, it, vi } from "vitest";
import {
  SigningController,
  SigningError,
  canonicalizeRequest,
  detectSignerCapability,
  type RequestSigner,
  type SignatureResult,
  type SigningPayload,
} from "../src/signing.js";
import { TalosClient } from "../src/client.js";

const signature: SignatureResult = {
  algorithm: "test-ed25519",
  keyId: "test-key",
  signature: new Uint8Array([1, 2, 3]),
};

function signer(
  implementation: (payload: SigningPayload, options?: { signal?: AbortSignal }) => Promise<SignatureResult> =
    async () => signature,
): RequestSigner {
  return {
    getCapabilities: () => ({
      capabilities: ["http-request-v1"],
      algorithms: ["test-ed25519"],
    }),
    sign: implementation,
  };
}

describe("request canonicalization", () => {
  it("matches the stable empty-body test vector", async () => {
    const bytes = await canonicalizeRequest({
      method: "get",
      url: "https://example.test/v1/jobs?z=2&a=1#ignored",
      headers: {
        "X-Zeta": "  one   two ",
        Authorization: "Bearer must-not-be-signed",
        Accept: "application/json",
      },
      timestamp: "2026-01-02T03:04:05.000Z",
      nonce: "vector-1",
    });

    expect(new TextDecoder().decode(bytes)).toBe(
      [
        "talos-request-v1",
        "GET",
        "https://example.test/v1/jobs?a=1&z=2",
        "accept:application/json\nx-zeta:one two",
        "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
        "2026-01-02T03:04:05.000Z",
        "vector-1",
      ].join("\n"),
    );
  });

  it("rejects non-replayable bodies", async () => {
    const stream = new ReadableStream();
    await expect(
      canonicalizeRequest({
        method: "POST",
        url: "https://example.test",
        body: stream,
        timestamp: "now",
        nonce: "n",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("SigningController", () => {
  it("detects capabilities without leaking provider failures", async () => {
    await expect(detectSignerCapability(signer(), "http-request-v1")).resolves.toBe(true);
    await expect(detectSignerCapability(signer(), "talos-payment-v1")).resolves.toBe(false);
  });

  it("bounds concurrency and rejects queue saturation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const controller = new SigningController(
      signer(async () => {
        await blocked;
        return signature;
      }),
      { maxConcurrent: 1, maxQueue: 1 },
    );
    const payload = { kind: "http-request-v1", bytes: new Uint8Array() } as const;
    const first = controller.sign(payload);
    const second = controller.sign(payload);
    await expect(controller.sign(payload)).rejects.toMatchObject({ code: "SATURATED" });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("maps timeout and cancellation to deterministic typed errors", async () => {
    const never = signer(() => new Promise(() => undefined));
    const controller = new SigningController(never, { timeoutMs: 5 });
    await expect(
      controller.sign({ kind: "http-request-v1", bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });

    const abort = new AbortController();
    abort.abort();
    await expect(
      controller.sign(
        { kind: "http-request-v1", bytes: new Uint8Array() },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED", retryable: false });
  });

  it("normalizes provider failures and validates results", async () => {
    const failed = new SigningController(signer(async () => { throw new Error("secret detail"); }));
    await expect(
      failed.sign({ kind: "http-request-v1", bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "SIGNING_FAILED" });

    const invalid = new SigningController(signer(async () => ({ ...signature, keyId: "" })));
    await expect(
      invalid.sign({ kind: "http-request-v1", bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: "INVALID_RESULT" });
  });
});

describe("TalosClient signer integration", () => {
  it("signs the real fetch boundary when explicitly configured", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1" }),
    }));
    const sign = vi.fn<RequestSigner["sign"]>(async () => signature);
    const client = new TalosClient({
      baseUrl: "https://example.test",
      apiKey: "private-api-key",
      signer: signer(sign),
    });

    await client.getTalos("1");

    expect(sign).toHaveBeenCalledOnce();
    const canonical = new TextDecoder().decode(sign.mock.calls[0][0].bytes);
    expect(canonical).not.toContain("private-api-key");
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/talos/1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Talos-Key-Id": "test-key",
          "X-Talos-Signature": "AQID",
        }),
      }),
    );
  });

  it("preserves unsigned legacy requests when no signer is configured", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "1" }),
    }));
    await new TalosClient({ baseUrl: "https://example.test" }).getTalos("1");
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Talos-Signature"]).toBeUndefined();
  });
});
