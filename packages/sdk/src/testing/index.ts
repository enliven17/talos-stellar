/** Utilities for mocking API responses in SDK consumer tests. */

export type MockRouteHandler = (request: MockRequest) => Response | Promise<Response>;

export interface MockRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

export type MockRoutes = Record<string, MockRouteHandler>;

export type MockFetch = typeof fetch & { requests: MockRequest[] };

export const builders = {
  json(body: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers);
    if (!responseHeaders.has("content-type")) {
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(JSON.stringify(body), { status, headers: responseHeaders });
  },

  text(body: string, status = 200, headers?: HeadersInit): Response {
    return new Response(body, { status, headers });
  },

  empty(status = 204, headers?: HeadersInit): Response {
    return new Response(null, { status, headers });
  },
};

/** Create a fetch-compatible mock that dispatches by method and URL path. */
export function createMockFetch(routes: MockRoutes): MockFetch {
  const requests: MockRequest[] = [];
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const bodySource = init?.body ?? (request?.body ? await request.clone().text() : null);
    const body = typeof bodySource === "string" ? bodySource : null;
    const recorded: MockRequest = { url, method, headers, body };
    requests.push(recorded);

    const pathname = new URL(url).pathname;
    const handler = routes[`${method} ${pathname}`];
    if (!handler) {
      throw new Error(`No route matched ${method} ${pathname}`);
    }
    return handler(recorded);
  }) as MockFetch;
  mock.requests = requests;
  return mock;
}

export const presets = {
  x402Challenge(): MockRoutes {
    return {
      "POST /v1/jobs": () => builders.json({
        x402Version: "1",
        accepts: [{ scheme: "exact", network: "stellar:testnet", maxAmountRequired: "1" }],
      }, 402),
    };
  },

  jobLifecycle(): MockRoutes {
    let reads = 0;
    return {
      "POST /v1/jobs": () => builders.json({ id: "job_mock_123", status: "queued" }, 202),
      "GET /v1/jobs/job_mock_123": () => {
        reads += 1;
        return builders.json({
          id: "job_mock_123",
          status: reads === 1 ? "running" : "succeeded",
        });
      },
    };
  },

  pagination<T>(options: { items: T[]; pageSize: number }): MockRoutes {
    return {
      "GET /v1/jobs": ({ url }) => {
        const search = new URL(url).searchParams;
        const offset = Number(search.get("cursor") ?? 0);
        const limit = Number(search.get("limit") ?? options.pageSize);
        const size = Number.isFinite(limit) && limit > 0 ? limit : options.pageSize;
        const items = options.items.slice(offset, offset + size);
        const nextOffset = offset + items.length;
        return builders.json({
          items,
          nextCursor: nextOffset < options.items.length ? String(nextOffset) : null,
        });
      },
    };
  },

  errorEnvelope(options: { status: number; code: string; message: string }): MockRoutes {
    return {
      "POST /v1/jobs": () => builders.json({
        error: { code: options.code, message: options.message },
      }, options.status),
    };
  },
};
