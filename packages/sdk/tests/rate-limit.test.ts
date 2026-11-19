import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TalosAPIError,
  TalosRateLimitError,
  errorFromResponse,
  parseRateLimit,
} from "../src/index.js";

const BASE_URL = "http://localhost:3000";

function emptyOkResponse(headers?: Headers): Response {
  return {
    ok: true,
    status: 200,
    headers,
    json: async () => ({ ok: true }),
  } as Response;
}

function rateLimitHeaders(): Headers {
  return new Headers({
    "X-RateLimit-Limit": "60",
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": "1700000000",
  });
}

describe("parseRateLimit", () => {
  it("parses limit/remaining/reset from a Headers instance", () => {
    expect(parseRateLimit(rateLimitHeaders())).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
  });

  it("parses lowercased header records", () => {
    expect(
      parseRateLimit({
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": "1700000001",
      }),
    ).toEqual({ limit: 100, remaining: 99, resetAt: 1_700_000_001_000 });
  });

  it("returns undefined when all headers are missing", () => {
    expect(parseRateLimit(new Headers())).toBeUndefined();
    expect(parseRateLimit({})).toBeUndefined();
    expect(parseRateLimit(undefined)).toBeUndefined();
  });

  it("omits malformed counters instead of throwing", () => {
    expect(
      parseRateLimit(
        new Headers({
          "X-RateLimit-Limit": "not-a-number",
          "X-RateLimit-Remaining": "-5",
          "X-RateLimit-Reset": "1.5",
        }),
      ),
    ).toBeUndefined();

    expect(
      parseRateLimit(
        new Headers({
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "",
          "X-RateLimit-Reset": "soon",
        }),
      ),
    ).toEqual({ limit: 60 });
  });

  it("returns the subset that was present", () => {
    expect(parseRateLimit(new Headers({ "X-RateLimit-Remaining": "7" }))).toEqual({
      remaining: 7,
    });
  });
});

describe("TalosAPIError rate limit exposure", () => {
  it("populates rateLimit from headers on a 429", () => {
    const err = errorFromResponse(429, "/api/talos", "Too many requests", rateLimitHeaders());
    expect(err).toBeInstanceOf(TalosRateLimitError);
    expect(err.rateLimit).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
    expect(err.toJSON()).toMatchObject({
      status: 429,
      rateLimit: { limit: 60, remaining: 0, resetAt: 1_700_000_000_000 },
    });
  });

  it("leaves rateLimit undefined when the response has no counters", () => {
    const err = errorFromResponse(429, "/api/talos", "Too many requests", new Headers());
    expect(err).toBeInstanceOf(TalosRateLimitError);
    expect(err.rateLimit).toBeUndefined();
    expect((err as TalosRateLimitError).limit).toBeUndefined();
    expect((err as TalosRateLimitError).remaining).toBeUndefined();
    expect((err as TalosRateLimitError).resetAt).toBeUndefined();
  });
});

describe("TalosClient rate-limit observability", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes onResponse with parsed counters on a successful response", async () => {
    const onResponse = vi.fn();
    const client = new TalosClient({ baseUrl: BASE_URL, onResponse });
    vi.mocked(fetch).mockResolvedValue(emptyOkResponse(rateLimitHeaders()));

    await client.getTalos("1");

    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
      path: "/api/talos/1",
      method: "GET",
      status: 200,
      attempt: 1,
      rateLimit: { limit: 60, remaining: 0, resetAt: 1_700_000_000_000 },
    });
    expect(client.getLastRateLimit()).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
  });

  it("yields undefined (not an error) when headers are missing", async () => {
    const onResponse = vi.fn();
    const client = new TalosClient({ baseUrl: BASE_URL, onResponse });
    vi.mocked(fetch).mockResolvedValue(emptyOkResponse());

    await expect(client.getTalos("1")).resolves.toEqual({ ok: true });

    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0].rateLimit).toBeUndefined();
    expect(client.getLastRateLimit()).toBeUndefined();
  });

  it("exposes counters on the thrown error and in onError for a 429", async () => {
    const onResponse = vi.fn();
    const onError = vi.fn();
    const client = new TalosClient({
      baseUrl: BASE_URL,
      onResponse,
      onError,
      // Disable retries so the 429 surfaces immediately.
      retryPolicy: { maxAttempts: 1 },
      retry: { maxAttempts: 1 },
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      headers: rateLimitHeaders(),
      text: async () => JSON.stringify({ error: "Too many requests" }),
    } as Response);

    const err = await client.getTalos("1").catch((e) => e);

    expect(err).toBeInstanceOf(TalosRateLimitError);
    expect(err.rateLimit).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
    expect(client.getLastRateLimit()).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        attempt: 1,
        rateLimit: { limit: 60, remaining: 0, resetAt: 1_700_000_000_000 },
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: err,
        rateLimit: { limit: 60, remaining: 0, resetAt: 1_700_000_000_000 },
      }),
    );
  });

  it("reports counters for every retry attempt and keeps the latest snapshot", async () => {
    const onResponse = vi.fn();
    const client = new TalosClient({
      baseUrl: BASE_URL,
      onResponse,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1700000000",
        }),
        text: async () => "Too Many Requests",
      } as Response)
      .mockResolvedValueOnce(
        emptyOkResponse(
          new Headers({
            "X-RateLimit-Limit": "60",
            "X-RateLimit-Remaining": "59",
            "X-RateLimit-Reset": "1700000060",
          }),
        ),
      );

    await client.getTalos("1");

    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
      status: 429,
      attempt: 1,
      rateLimit: { remaining: 0 },
    });
    expect(onResponse.mock.calls[1]?.[0]).toMatchObject({
      status: 200,
      attempt: 2,
      rateLimit: { remaining: 59 },
    });
    expect(client.getLastRateLimit()).toEqual({
      limit: 60,
      remaining: 59,
      resetAt: 1_700_000_060_000,
    });
  });

  it("retains the last known counters when a later response omits them", async () => {
    const client = new TalosClient({ baseUrl: BASE_URL });
    vi.mocked(fetch)
      .mockResolvedValueOnce(emptyOkResponse(rateLimitHeaders()))
      .mockResolvedValueOnce(emptyOkResponse());

    await client.getTalos("1");
    expect(client.getLastRateLimit()).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });

    await client.getTalos("2");
    expect(client.getLastRateLimit()).toEqual({
      limit: 60,
      remaining: 0,
      resetAt: 1_700_000_000_000,
    });
  });

  it("a throwing observer cannot break the request", async () => {
    const client = new TalosClient({
      baseUrl: BASE_URL,
      onResponse: () => {
        throw new Error("observer boom");
      },
    });
    vi.mocked(fetch).mockResolvedValue(emptyOkResponse(rateLimitHeaders()));

    await expect(client.getTalos("1")).resolves.toEqual({ ok: true });
    expect(client.getLastRateLimit()).toMatchObject({ limit: 60 });
  });

  it("uses the same parsed metadata on errors as on responses", async () => {
    const client = new TalosClient({
      baseUrl: BASE_URL,
      retryPolicy: { maxAttempts: 1 },
      retry: { maxAttempts: 1 },
    });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "X-RateLimit-Limit": "abc" }),
      text: async () => "",
    } as Response);

    const err = (await client.getTalos("1").catch((e) => e)) as TalosAPIError;
    expect(err.rateLimit).toBeUndefined();
  });
});
