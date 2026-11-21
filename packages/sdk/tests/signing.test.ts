import { describe, expect, it, vi } from "vitest";
import signingVectors from "./fixtures/request-signing-vectors.json" with { type: "json" };
import {
  REQUEST_SIGNATURE_VERSION,
  SigningController,
  canonicalizeRequest,
  detectSignerCapability,
  type RequestSigner,
  type SignatureResult,
  type SigningPayload,
} from "../src/index.js";
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
  it("publishes vectors for the supported signature version", () => {
    expect(signingVectors.format).toBe("talos-request-signing-vectors");
    expect(signingVectors.version).toBe(REQUEST_SIGNATURE_VERSION);
  });
  for (const vector of signingVectors.vectors) {
    it(`matches the published ${vector.name} byte vector`, async () => {
      const bytes = await canonicalizeRequest(vector.request);
      expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(vector.canonical)));
    });
  }

  it("rejects line breaks and credential-bearing request URLs", async () => {
    const valid = { method: "GET", url: "https://example.test/", timestamp: "now", nonce: "n" };
    await expect(canonicalizeRequest(undefined as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const injectedNonce = { ...valid, nonce: ["n", "forged"].join("\n") };
    const injectedTimestamp = { ...valid, timestamp: ["now", "forged"].join("\r\n") };
    const credentialUrl = { ...valid, url: "https://user:pass@example.test/" };
    await expect(canonicalizeRequest(injectedNonce)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(canonicalizeRequest(injectedTimestamp)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(canonicalizeRequest(credentialUrl)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("uses the browser Web API path without Node Buffer", async () => {
    const vector = signingVectors.vectors[1];
    vi.stubGlobal("Buffer", undefined);
    try {
      const bytes = await canonicalizeRequest(vector.request);
      expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(vector.canonical)));
    } finally {
      vi.unstubAllGlobals();
    }
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
