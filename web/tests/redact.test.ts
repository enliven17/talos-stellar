import { describe, it, expect } from "vitest";
import pino from "pino";
import { redactPayload } from "../src/lib/redact";

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
      }
    });

    const logged = logs[0];

    // Assert the secret values are nowhere to be found in the stringified log
    const logString = JSON.stringify(logged);
    expect(logString).not.toContain("super-secret-token");
    expect(logString).not.toContain("sk-live-12345");
    expect(logString).not.toContain("stellar-secret-key-123");
    expect(logString).not.toContain("hex-sig-456");

    // Assert that safe context is retained
    expect(logString).toContain("test");
    expect(logString).toContain("application/json");
  });
});
