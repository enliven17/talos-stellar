import { BenchmarkOptions } from "../runner";
import { loadConfig } from "../config";

const config = loadConfig({ runs: 50, warmupRuns: 5 });

interface TalosClientStub {
  baseUrl: string;
  headers: Record<string, string>;
}

function createClientStub(): TalosClientStub {
  return {
    baseUrl: "https://api.talos.local",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer tak_benchmark_test_key_0000000000000000000000000000000000000000000",
    },
  };
}

function buildUrl(baseUrl: string, path: string, params?: Record<string, string | undefined>): string {
  let url = `${baseUrl}${path}`;
  if (params) {
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) filtered[k] = v;
    }
    const qs = new URLSearchParams(filtered).toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

function serializeRequest(method: string, url: string, body?: unknown, headers?: Record<string, string>): string {
  const h = headers ?? {};
  const payload = JSON.stringify({
    method,
    url,
    headers: { "Content-Type": "application/json", ...h },
    body: body !== undefined ? body : undefined,
  });
  return payload;
}

function parseResponse<T>(json: string): { data: T; nextCursor: string | null } {
  return JSON.parse(json);
}

function buildPaginatedResponse<T>(items: T[], limit: number): { data: T[]; nextCursor: string | null } {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const lastItem = page[page.length - 1];
  const nextCursor = hasMore && lastItem
    ? `${Date.now()}|${(lastItem as any).id ?? ""}`
    : null;
  return { data: page, nextCursor };
}

export function sdkSerializationSuite(): BenchmarkOptions[] {
  const client = createClientStub();
  const talosPayload = {
    name: "Benchmark Agent",
    category: "Development",
    description: "A benchmark agent for performance testing",
    totalSupply: 1000000,
    creatorPublicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234",
    signature: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    message: "talos-genesis:Benchmark Agent:null:1000000",
  };

  const activityPayload = {
    type: "research",
    content: "Benchmark activity entry for performance testing of the SDK serialization path",
    channel: "twitter",
  };

  const transferPayload = {
    agent: "benchmark-agent",
    destination: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ234",
    asset: "USDC",
    amount: "10.00",
    nonce: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    expiry: "9999999999",
    signature: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  };

  return [
    {
      label: "sdk-create-talos-serialize",
      fn: () => {
        serializeRequest("POST", `${client.baseUrl}/api/talos`, talosPayload, client.headers);
      },
      config,
    },
    {
      label: "sdk-list-talos-url-build",
      fn: () => {
        buildUrl(client.baseUrl, "/api/talos", { limit: "50", cursor: undefined });
      },
      config,
    },
    {
      label: "sdk-report-activity-serialize",
      fn: () => {
        serializeRequest(
          "POST",
          `${client.baseUrl}/api/talos/bench-id/activity`,
          activityPayload,
          client.headers,
        );
      },
      config,
    },
    {
      label: "sdk-transfer-serialize",
      fn: () => {
        serializeRequest(
          "POST",
          `${client.baseUrl}/api/talos/bench-id/transfer`,
          transferPayload,
          client.headers,
        );
      },
      config,
    },
    {
      label: "sdk-paginated-response-parse",
      fn: () => {
        const items = Array.from({ length: 50 }, (_, i) => ({
          id: `talos-${i}`,
          name: `Agent ${i}`,
          category: "Research",
          status: "Active",
        }));
        const result = buildPaginatedResponse(items, 50);
        const json = JSON.stringify(result);
        const parsed = parseResponse<typeof items>(json);
        if (!parsed.data) throw new Error("parse failed");
      },
      config,
    },
    {
      label: "sdk-large-batch-deserialize",
      fn: () => {
        const items = Array.from({ length: 200 }, (_, i) => ({
          id: `item-${i}`,
          name: `Batch Item ${i}`,
          value: Math.random() * 1000,
          tags: [`tag-${i % 10}`, `category-${i % 5}`],
          metadata: { created: Date.now(), version: 2 },
        }));
        const json = JSON.stringify({ data: items, nextCursor: null });
        const parsed = JSON.parse(json);
        if (!parsed.data) throw new Error("parse failed");
      },
      config,
    },
    {
      label: "sdk-error-response-parse",
      fn: () => {
        const errorBody = JSON.stringify({ error: "Invalid API key" });
        const parsed = JSON.parse(errorBody);
        if (!parsed.error) throw new Error("missing error");
      },
      config,
    },
  ];
}

export function sdkSuites(): BenchmarkOptions[] {
  return sdkSerializationSuite();
}