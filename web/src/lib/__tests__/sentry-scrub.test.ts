import { describe, expect, it } from "vitest";
import type { Event } from "@sentry/nextjs";
import { REDACTED, scrubSentryEvent } from "../sentry-scrub";

describe("scrubSentryEvent", () => {
  it("removes user identity, credentials, sensitive payloads, and URL queries", () => {
    const result = scrubSentryEvent({
      request: {
        url: "https://example.test/api/payments?email=alice@example.test&token=secret",
        headers: { authorization: "Bearer secret", "x-request-id": "safe-id" },
        cookies: { session: "cookie-value" },
      },
      user: { id: "user-123", email: "alice@example.test" },
      extra: { walletAddress: "GABC", amount: 4, retryCount: 2 },
      breadcrumbs: [{ category: "payment", data: { paymentProof: "proof", attempt: 1 } }],
    } as Event);

    expect(result.user).toBeUndefined();
    expect(result.request?.url).toBe("https://example.test/api/payments");
    expect(result.request?.headers).toBeUndefined();
    expect(result.request?.cookies).toBeUndefined();
    expect(result.extra?.walletAddress).toBe(REDACTED);
    expect(result.extra?.amount).toBe(4);
    expect(result.breadcrumbs?.[0].data?.paymentProof).toBe(REDACTED);
    expect(result.breadcrumbs?.[0].data?.attempt).toBe(1);
  });

  it("fails closed for malformed URLs without discarding safe diagnostics", () => {
    const result = scrubSentryEvent({
      request: { url: "not a URL?secret=hidden" },
      extra: { operation: "health-check", retryCount: 0 },
    } as Event);

    expect(result.request?.url).toBe("not a URL");
    expect(result.extra).toEqual({ operation: "health-check", retryCount: 0 });
  });

  it("clears the request query string that Sentry sends apart from the URL", () => {
    const result = scrubSentryEvent({
      request: {
        url: "https://example.test/api/payments",
        query_string: "email=alice@example.test&token=secret",
      },
    } as Event);

    expect(result.request?.query_string).toBeUndefined();
    expect(result.request?.url).toBe("https://example.test/api/payments");
  });

  it("scrubs sampled performance transactions the same way as error events", () => {
    const result = scrubSentryEvent({
      type: "transaction",
      transaction: "GET /api/payments",
      user: { id: "user-123", email: "alice@example.test" },
      request: {
        url: "https://example.test/api/payments?token=secret",
        query_string: "token=secret",
        headers: { authorization: "Bearer secret" },
      },
      extra: { walletAddress: "GABC", spanCount: 3 },
    } as Event);

    expect(result.user).toBeUndefined();
    expect(result.request?.query_string).toBeUndefined();
    expect(result.request?.headers).toBeUndefined();
    expect(result.request?.url).toBe("https://example.test/api/payments");
    expect(result.extra?.walletAddress).toBe(REDACTED);
    expect(result.extra?.spanCount).toBe(3);
    expect(result.transaction).toBe("GET /api/payments");
  });

  it("handles cyclic diagnostic data without throwing", () => {
    const extra: Record<string, unknown> = { operation: "cycle" };
    extra.self = extra;
    expect(() => scrubSentryEvent({ extra } as Event)).not.toThrow();
    expect((scrubSentryEvent({ extra } as Event).extra?.self)).toBe(REDACTED);
  });
});
