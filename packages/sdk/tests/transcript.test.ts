import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TalosClient,
  TranscriptRecorder,
  TranscriptReplayer,
  createTranscriptRecorder,
  createTranscriptReplayer,
  parseTranscript,
  sanitizeTranscriptPath,
  sanitizeTranscriptHeaders,
  type HttpTranscript,
  type TranscriptEntry,
  TalosServerError,
} from "../src/index.js";

describe("Deterministic HTTP Transcript Recorder & Replayer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Sanitization Utilities", () => {
    it("redacts sensitive query parameters from URLs and paths", () => {
      const url = "https://api.talos.protocol/api/jobs?token=secret123&apiKey=key456&safe=value";
      const sanitized = sanitizeTranscriptPath(url);
      expect(sanitized).toContain("safe=value");
      expect(sanitized).not.toContain("secret123");
      expect(sanitized).not.toContain("key456");
      expect(sanitized).toContain("token=%5BREDACTED%5D");
    });

    it("redacts sensitive request and response headers", () => {
      const headers = new Headers({
        authorization: "Bearer secret-jwt-token",
        "x-api-key": "tlk_supersecret",
        cookie: "session=xyz",
        "content-type": "application/json",
        "x-request-id": "req-123",
      });

      const sanitized = sanitizeTranscriptHeaders(headers);
      expect(sanitized["authorization"]).toBe("[REDACTED]");
      expect(sanitized["x-api-key"]).toBe("[REDACTED]");
      expect(sanitized["cookie"]).toBe("[REDACTED]");
      expect(sanitized["content-type"]).toBe("application/json");
      expect(sanitized["x-request-id"]).toBe("req-123");
    });
  });

  describe("TranscriptRecorder unit tests", () => {
    it("records method, path, status, and timings without storing request bodies", () => {
      const recorder = new TranscriptRecorder();

      const entry = recorder.record({
        method: "post",
        path: "/api/talos?apiKey=secret-key",
        status: 201,
        statusText: "Created",
        durationMs: 45,
        requestHeaders: {
          authorization: "Bearer my-token",
          "content-type": "application/json",
        },
        responseHeaders: {
          "content-type": "application/json",
          "x-request-id": "req-abc",
        },
        responseBody: { id: "talos_1", name: "Agent1" },
      });

      expect(entry.method).toBe("POST");
      expect(entry.path).toBe("/api/talos?apiKey=%5BREDACTED%5D");
      expect(entry.status).toBe(201);
      expect(entry.statusText).toBe("Created");
      expect(entry.durationMs).toBe(45);
      expect(typeof entry.startedAt).toBe("string");
      expect(entry.requestHeaders?.["authorization"]).toBe("[REDACTED]");
      expect(entry.requestHeaders?.["content-type"]).toBe("application/json");
      expect(entry.responseBody).toEqual({ id: "talos_1", name: "Agent1" });

      // STRICT PRIVACY CHECK: Request body is never stored anywhere on the entry
      expect((entry as any).requestBody).toBeUndefined();
      expect((entry.request as any).body).toBeUndefined();
    });

    it("respects maxEntries capacity limit", () => {
      const recorder = new TranscriptRecorder({ maxEntries: 3 });
      recorder.record({ method: "GET", path: "/1", status: 200, durationMs: 5 });
      recorder.record({ method: "GET", path: "/2", status: 200, durationMs: 5 });
      recorder.record({ method: "GET", path: "/3", status: 200, durationMs: 5 });
      recorder.record({ method: "GET", path: "/4", status: 200, durationMs: 5 });

      const entries = recorder.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[0].path).toBe("/2");
      expect(entries[1].path).toBe("/3");
      expect(entries[2].path).toBe("/4");
    });

    it("exports valid HttpTranscript format and parses correctly", () => {
      const recorder = createTranscriptRecorder({ metadata: { env: "staging" } });
      recorder.record({ method: "GET", path: "/api/health", status: 200, durationMs: 10 });

      const jsonStr = recorder.export();
      const parsed = parseTranscript(jsonStr);

      expect(parsed.version).toBe(1);
      expect(parsed.metadata?.env).toBe("staging");
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].method).toBe("GET");
      expect(parsed.entries[0].path).toBe("/api/health");
    });
  });

  describe("TranscriptReplayer unit tests", () => {
    it("replays synthetic responses deterministically without request bodies", async () => {
      const transcript: HttpTranscript = {
        version: 1,
        recordedAt: new Date().toISOString(),
        entries: [
          {
            id: "tx-1",
            attempt: 1,
            method: "POST",
            path: "/api/jobs/job-1/claim",
            status: 200,
            statusText: "OK",
            durationMs: 25,
            startedAt: new Date().toISOString(),
            responseBody: { id: "job-1", fencingToken: 42, status: "claimed" },
            request: { method: "POST", path: "/api/jobs/job-1/claim", headers: {} },
            response: { status: 200, headers: {}, body: { id: "job-1", fencingToken: 42, status: "claimed" } },
            timing: { durationMs: 25, startedAt: new Date().toISOString() },
          },
        ],
      };

      const replayer = new TranscriptReplayer(transcript);
      // Replaying requires NO knowledge of the request body
      const res = await replayer.fetch("https://api.talos.protocol/api/jobs/job-1/claim", {
        method: "POST",
        body: JSON.stringify({ secretPrivatePayload: "must-not-matter" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ id: "job-1", fencingToken: 42, status: "claimed" });
      expect(replayer.getPlayedEntries()).toHaveLength(1);
      expect(replayer.getRemainingEntries()).toHaveLength(0);
    });

    it("replays retry sequence in FIFO order (e.g. 503 -> 200)", async () => {
      const transcript: HttpTranscript = {
        version: 1,
        recordedAt: new Date().toISOString(),
        entries: [
          {
            id: "tx-fail",
            attempt: 1,
            method: "GET",
            path: "/api/jobs/pending",
            status: 503,
            statusText: "Service Unavailable",
            durationMs: 30,
            startedAt: new Date().toISOString(),
            responseBody: { error: "Temporarily unavailable" },
            request: { method: "GET", path: "/api/jobs/pending", headers: {} },
            response: { status: 503, headers: {}, body: { error: "Temporarily unavailable" } },
            timing: { durationMs: 30, startedAt: new Date().toISOString() },
          },
          {
            id: "tx-ok",
            attempt: 2,
            method: "GET",
            path: "/api/jobs/pending",
            status: 200,
            statusText: "OK",
            durationMs: 20,
            startedAt: new Date().toISOString(),
            responseBody: [{ id: "job_xyz" }],
            request: { method: "GET", path: "/api/jobs/pending", headers: {} },
            response: { status: 200, headers: {}, body: [{ id: "job_xyz" }] },
            timing: { durationMs: 20, startedAt: new Date().toISOString() },
          },
        ],
      };

      const fetchMock = createTranscriptReplayer(transcript);

      const firstRes = await fetchMock("http://localhost:3000/api/jobs/pending");
      expect(firstRes.status).toBe(503);

      const secondRes = await fetchMock("http://localhost:3000/api/jobs/pending");
      expect(secondRes.status).toBe(200);
      expect(await secondRes.json()).toEqual([{ id: "job_xyz" }]);
    });

    it("throws descriptive error for unmatched routes", async () => {
      const replayer = new TranscriptReplayer([]);
      await expect(
        replayer.fetch("http://localhost:3000/api/nonexistent"),
      ).rejects.toThrow(/No matching transcript entry/i);
    });

    it("returns 404 when configured with onUnmatched: '404'", async () => {
      const replayer = new TranscriptReplayer([], { onUnmatched: "404" });
      const res = await replayer.fetch("http://localhost:3000/api/nonexistent");
      expect(res.status).toBe(404);
    });

    it("replays status 0 as transport error", async () => {
      const transcript: HttpTranscript = {
        version: 1,
        recordedAt: new Date().toISOString(),
        entries: [
          {
            id: "tx-net-err",
            attempt: 1,
            method: "GET",
            path: "/api/network-down",
            status: 0,
            durationMs: 15,
            startedAt: new Date().toISOString(),
            request: { method: "GET", path: "/api/network-down", headers: {} },
            response: { status: 0, headers: {} },
            timing: { durationMs: 15, startedAt: new Date().toISOString() },
          },
        ],
      };

      const replayer = new TranscriptReplayer(transcript);
      await expect(replayer.fetch("http://localhost:3000/api/network-down")).rejects.toThrow(
        /Simulated transport failure/i,
      );
    });
  });

  describe("TalosClient End-to-End Recording and Replaying", () => {
    it("records client requests with sanitization and captures no request bodies", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => [{ id: "job_1", status: "pending" }],
        clone: function () {
          return {
            text: async () => JSON.stringify([{ id: "job_1", status: "pending" }]),
          } as Response;
        },
      } as unknown as Response);

      const recordedEntries: TranscriptEntry[] = [];
      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "tlk_super_secret_key",
        recorder: true,
        onTranscriptEntry: (e) => recordedEntries.push(e),
      });

      const pendingJobs = await client.getPendingJobs();
      expect(pendingJobs).toHaveLength(1);

      const transcript = client.getTranscript();
      expect(transcript).toBeDefined();
      expect(transcript?.entries).toHaveLength(1);
      expect(recordedEntries).toHaveLength(1);

      const entry = transcript!.entries[0];
      expect(entry.method).toBe("GET");
      expect(entry.path).toBe("/api/jobs/pending");
      expect(entry.status).toBe(200);
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      // Authorization header must be redacted
      expect(entry.requestHeaders?.["authorization"]).toBe("[REDACTED]");
      // Response body captured
      expect(entry.responseBody).toEqual([{ id: "job_1", status: "pending" }]);
      // Request body NEVER present
      expect((entry as any).requestBody).toBeUndefined();
    });

    it("records POST requests without saving private request bodies", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ id: "sub-1", url: "https://example.com/webhook", status: "active" }),
        clone: function () {
          return {
            text: async () => JSON.stringify({ id: "sub-1", url: "https://example.com/webhook", status: "active" }),
          } as Response;
        },
      } as unknown as Response);

      const client = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "tlk_key",
        recorder: true,
      });

      // Issue a write with a payload that could contain sensitive information
      await client.createWebhookSubscription({
        url: "https://example.com/webhook",
        eventTypes: ["job.completed"],
        secret: "super-secret-webhook-key",
      });

      const transcript = client.getTranscript()!;
      expect(transcript.entries).toHaveLength(1);
      const entry = transcript.entries[0];

      expect(entry.method).toBe("POST");
      expect(entry.path).toBe("/api/webhooks/subscriptions");
      expect(entry.status).toBe(200);

      // Verify request body was NOT recorded
      expect((entry as any).requestBody).toBeUndefined();
      expect((entry.request as any).body).toBeUndefined();
      // Ensure the text of the request body is nowhere in the serialized JSON
      const serialized = JSON.stringify(transcript);
      expect(serialized).not.toContain("super-secret-webhook-key");
    });

    it("replays recorded transcript through a new TalosClient without network access", async () => {
      // 1. Simulate a recorded session transcript
      const recordedTranscript: HttpTranscript = {
        version: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            id: "tx-1",
            attempt: 1,
            method: "GET",
            path: "/api/talos/me",
            status: 200,
            statusText: "OK",
            durationMs: 12,
            startedAt: "2026-01-01T00:00:00.000Z",
            requestHeaders: { authorization: "[REDACTED]" },
            responseHeaders: { "content-type": "application/json" },
            responseBody: {
              id: "talos_123",
              name: "ReplayAgent",
              category: "finance",
              status: "active",
            },
            request: { method: "GET", path: "/api/talos/me", headers: { authorization: "[REDACTED]" } },
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              body: { id: "talos_123", name: "ReplayAgent", category: "finance", status: "active" },
            },
            timing: { durationMs: 12, startedAt: "2026-01-01T00:00:00.000Z" },
          },
        ],
      };

      // 2. Initialize new client with replayTranscript — fetch will NOT be called
      const replayClient = new TalosClient({
        baseUrl: "http://localhost:3000",
        apiKey: "tlk_dummy",
        replayTranscript: recordedTranscript,
      });

      const me = await replayClient.getTalosMe();
      expect(me.id).toBe("talos_123");
      expect(me.name).toBe("ReplayAgent");
      // Verify global fetch was never invoked
      expect(fetch).not.toHaveBeenCalled();
    });

    it("replays transient retry through TalosClient retry policy deterministically", async () => {
      const transcript: HttpTranscript = {
        version: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          {
            id: "tx-503",
            attempt: 1,
            method: "GET",
            path: "/api/jobs/pending",
            status: 503,
            statusText: "Service Unavailable",
            durationMs: 10,
            startedAt: "2026-01-01T00:00:00.000Z",
            responseHeaders: { "retry-after": "0" },
            responseBody: { error: "overloaded" },
            request: { method: "GET", path: "/api/jobs/pending", headers: {} },
            response: { status: 503, headers: { "retry-after": "0" }, body: { error: "overloaded" } },
            timing: { durationMs: 10, startedAt: "2026-01-01T00:00:00.000Z" },
          },
          {
            id: "tx-200",
            attempt: 2,
            method: "GET",
            path: "/api/jobs/pending",
            status: 200,
            statusText: "OK",
            durationMs: 15,
            startedAt: "2026-01-01T00:00:00.010Z",
            responseHeaders: { "content-type": "application/json" },
            responseBody: [{ id: "job_recovered" }],
            request: { method: "GET", path: "/api/jobs/pending", headers: {} },
            response: { status: 200, headers: { "content-type": "application/json" }, body: [{ id: "job_recovered" }] },
            timing: { durationMs: 15, startedAt: "2026-01-01T00:00:00.010Z" },
          },
        ],
      };

      const replayClient = new TalosClient({
        baseUrl: "http://localhost:3000",
        replayTranscript: transcript,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
      });

      const jobs = await replayClient.getPendingJobs();
      expect(jobs).toEqual([{ id: "job_recovered" }]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
