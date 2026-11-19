import { describe, it, expect } from "vitest";
import pino from "pino";
import {
  redactPayload,
  redactSensitiveQueryFields,
  isSensitiveKey,
  REDACTED,
} from "../src/lib/redact";

describe("redactPayload", () => {
  it("redacts top-level sensitive keys", () => {
    const payload = {
      apiKey: "sk-12345",
      authorization: "Bearer token",
      signature: "0xabc123",
      paymentProof: "S12345",
      safeKey: "hello",
    };

    const result = redactPayload(payload);
    
    expect(result).toEqual({
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
      signature: "[REDACTED]",
      paymentProof: "[REDACTED]",
      safeKey: "hello",
    });
  });

  it("redacts nested sensitive keys recursively", () => {
    const payload = {
      event: "payment",
      data: {
        user: {
          id: 1,
          authorization: "Bearer secret",
        },
        payment: {
          amount: 100,
          paymentProof: "proof-string",
        },
        meta: [
          { apiKey: "key1", other: "val1" },
          { signature: "sig1", other: "val2" }
        ]
      }
    };

    const result = redactPayload(payload);

    expect(result.data.user.authorization).toBe("[REDACTED]");
    expect(result.data.payment.paymentProof).toBe("[REDACTED]");
    expect(result.data.meta[0].apiKey).toBe("[REDACTED]");
    expect(result.data.meta[0].other).toBe("val1");
    expect(result.data.meta[1].signature).toBe("[REDACTED]");
    expect(result.data.meta[1].other).toBe("val2");
  });

  it("handles circular references safely", () => {
    const payload: { safe: string; self?: unknown } = {
      safe: "data"
    };
    payload.self = payload;

    const result = redactPayload(payload);
    expect(result.safe).toBe("data");
    expect(result.self).toBe("[CIRCULAR]");
  });

  it("scrubs sensitive query fields inside URL string values", () => {
    const result = redactPayload({
      url: "https://app.example/api?page=2&api_key=sk-live&filter=open",
      path: "/activity?token=abc&cursor=c1",
    });

    expect(result.url).toBe(
      "https://app.example/api?page=2&api_key=%5BREDACTED%5D&filter=open",
    );
    expect(result.path).toContain("cursor=c1");
    expect(result.path).toContain(`token=${encodeURIComponent(REDACTED)}`);
    expect(JSON.stringify(result)).not.toContain("sk-live");
    expect(JSON.stringify(result)).not.toContain("token=abc");
  });
});

describe("redactSensitiveQueryFields", () => {
  it("redacts sensitive fields and keeps safe context (positive)", () => {
    const out = redactSensitiveQueryFields(
      "https://talos.example/api/activity?page=2&apiKey=sk-secret&filter=Service&payment_proof=PROOF",
    );
    expect(out).toContain("page=2");
    expect(out).toContain("filter=Service");
    expect(out).toContain(`apiKey=${encodeURIComponent(REDACTED)}`);
    expect(out).toContain(`payment_proof=${encodeURIComponent(REDACTED)}`);
    expect(out).not.toContain("sk-secret");
    expect(out).not.toContain("PROOF");
  });

  it("is a no-op when the query string is missing", () => {
    expect(redactSensitiveQueryFields("https://talos.example/health")).toBe(
      "https://talos.example/health",
    );
  });

  it("handles relative URLs and preserves the hash fragment", () => {
    const out = redactSensitiveQueryFields(
      "/callback?code=ok&seed=SSECRET&state=xyz#section",
    );
    expect(out.startsWith("/callback?")).toBe(true);
    expect(out).toContain("code=ok");
    expect(out).toContain("state=xyz");
    expect(out).toContain(`seed=${encodeURIComponent(REDACTED)}`);
    expect(out.endsWith("#section")).toBe(true);
    expect(out).not.toContain("SSECRET");
  });

  it("redacts every duplicate sensitive key (boundary)", () => {
    const out = redactSensitiveQueryFields(
      "https://x.test/r?token=one&token=two&q=ok",
    );
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).toContain("q=ok");
    expect(out.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it("fails closed on malformed query suffixes (negative)", () => {
    // Opaque string with a query-like suffix — secrets must not survive.
    const out = redactSensitiveQueryFields("not a URL?token=hidden&ok=1");
    expect(out).not.toContain("hidden");
    expect(out).toContain("not a URL");
  });

  it("treats hyphenated and underscored aliases as sensitive", () => {
    expect(isSensitiveKey("api-key")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("private-key")).toBe(true);
    expect(isSensitiveKey("page")).toBe(false);

    const out = redactSensitiveQueryFields(
      "https://x.test/?api-key=a&private_key=b&mnemonic=c&media=d",
    );
    expect(out).not.toMatch(/=a\b/);
    expect(out).not.toMatch(/=b\b/);
    expect(out).not.toContain("mnemonic=c");
    expect(out).not.toContain("media=d");
  });
});

describe("logger output", () => {
  it("proves raw fixture secrets are absent from stored logs", () => {
    const logs: unknown[] = [];
    // Create a new logger with the same formatters as the main logger but writing to an array
    const testLogger = pino(
      {
        formatters: {
          log: (obj) => redactPayload(obj),
        },
      },
      {
        write: (msg: string) => {
          logs.push(JSON.parse(msg));
        },
      }
    );

    testLogger.info({
      event: "test",
      headers: {
        authorization: "Bearer super-secret-token",
        accept: "application/json",
      },
      body: {
        apiKey: "sk-live-12345",
        nested: {
          paymentProof: "stellar-secret-key-123",
          signature: "hex-sig-456",
        }
      },
      publicUrl:
        "https://app.example/share?token=leak-me&cursor=abc",
    });

    const logged = logs[0];

    // Assert the secret values are nowhere to be found in the stringified log
    const logString = JSON.stringify(logged);
    expect(logString).not.toContain("super-secret-token");
    expect(logString).not.toContain("sk-live-12345");
    expect(logString).not.toContain("stellar-secret-key-123");
    expect(logString).not.toContain("hex-sig-456");
    expect(logString).not.toContain("leak-me");

    // Assert that safe context is retained
    expect(logString).toContain("test");
    expect(logString).toContain("application/json");
    expect(logString).toContain("cursor=abc");
  });
});
