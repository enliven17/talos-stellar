/**
 * Tests for TalosClient lifecycle methods.
 *
 * Covers (per issue #1010 acceptance criteria):
 *  - listLifecycleEvents calls the right route and paginates (single page + multi-page).
 *  - paginateLifecycleEvents yields an async iterator across pages.
 *  - setLifecycleStatus sends the right body for Active/Paused/Retired.
 *  - The 403 retirement guard: setting "Retired" without governanceApproved
 *    surfaces a TalosForbiddenError with the server's message.
 *  - Invalid statuses are compile-time errors (asserted via @ts-expect-error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TalosClient } from "../src/client.js";
import { TalosAPIError, TalosForbiddenError } from "../src/errors.js";
import type {
  LifecycleEvent,
  LifecycleStatus,
  LifecycleStatusResponse,
} from "../src/types.js";

const BASE_URL = "http://localhost:3000";

/** Build a lifecycle event row the way the server serializes it. */
function makeEvent(sequence: number, eventType = "agent.lifecycle.activated"): LifecycleEvent {
  return {
    id: `evt-${sequence}`,
    sequence,
    eventType,
    fromState: sequence > 1 ? "paused" : null,
    toState: "active",
    actorId: "GACTOR",
    actorRole: "operator",
    jobId: null,
    stepName: null,
    detail: { action: "activate" },
    createdAt: `2026-01-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
  };
}

/** Build the raw server response from GET /api/talos/:id/lifecycle. */
function lifecycleResponse(
  events: LifecycleEvent[],
  nextCursor: number | null,
): { events: LifecycleEvent[]; nextCursor: number | null } {
  return { events, nextCursor };
}

/** Build a successful PATCH /status response. */
function statusResponse(id: string, status: string): LifecycleStatusResponse {
  return {
    id,
    status,
    agentOnline: status === "Active",
    agentLastSeen: "2026-01-01T00:00:00.000Z",
  };
}

/** Build a fetch Response with JSON body. */
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a fetch error Response with a text body. */
function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("TalosClient lifecycle methods", () => {
  let client: TalosClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    client = new TalosClient({ baseUrl: BASE_URL, apiKey: "test-key" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── listLifecycleEvents ─────────────────────────────────────────

  describe("listLifecycleEvents", () => {
    it("calls GET /api/talos/:id/lifecycle and normalizes the response", async () => {
      const events = [makeEvent(3), makeEvent(2), makeEvent(1)];
      vi.mocked(fetch).mockResolvedValue(
        okJson(lifecycleResponse(events, 1)),
      );

      const page = await client.listLifecycleEvents("talos-1", { limit: 3 });

      // Correct route + query params
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/talos/talos-1/lifecycle?limit=3`);
      expect(init.method).toBe("GET");

      // Normalized CursorPage shape
      expect(page.data).toHaveLength(3);
      expect(page.data[0]).toEqual(events[0]);
      expect(page.nextCursor).toBe("1");
    });

    it("passes viewer and cursor (before) as query params", async () => {
      vi.mocked(fetch).mockResolvedValue(
        okJson(lifecycleResponse([makeEvent(1)], null)),
      );

      await client.listLifecycleEvents("talos-1", {
        cursor: "5",
        limit: 10,
        viewer: "GVIEWER",
      });

      const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      const params = new URLSearchParams(url.split("?")[1]!);
      expect(params.get("before")).toBe("5");
      expect(params.get("limit")).toBe("10");
      expect(params.get("viewer")).toBe("GVIEWER");
    });

    it("returns an empty page when there are no events", async () => {
      vi.mocked(fetch).mockResolvedValue(
        okJson(lifecycleResponse([], null)),
      );

      const page = await client.listLifecycleEvents("talos-1");

      expect(page.data).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });

    it("retries on a transient 503 and succeeds (default retry policy)", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(errorJson(503, "Service Unavailable"))
        .mockResolvedValueOnce(okJson(lifecycleResponse([makeEvent(1)], null)));

      const page = await client.listLifecycleEvents("talos-1");

      expect(page.data).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── paginateLifecycleEvents ────────────────────────────────────

  describe("paginateLifecycleEvents", () => {
    it("yields events across multiple pages until the cursor is exhausted", async () => {
      const page1 = [makeEvent(4), makeEvent(3)];
      const page2 = [makeEvent(2), makeEvent(1)];

      vi.mocked(fetch)
        .mockResolvedValueOnce(okJson(lifecycleResponse(page1, 2)))
        .mockResolvedValueOnce(okJson(lifecycleResponse(page2, null)));

      const collected: LifecycleEvent[] = [];
      for await (const event of client.paginateLifecycleEvents("talos-1", { limit: 2 })) {
        collected.push(event);
      }

      expect(collected.map((e) => e.sequence)).toEqual([4, 3, 2, 1]);
      expect(fetch).toHaveBeenCalledTimes(2);

      // First fetch uses no cursor; second uses the numeric nextCursor (as string)
      const firstUrl = vi.mocked(fetch).mock.calls[0][0] as string;
      const secondUrl = vi.mocked(fetch).mock.calls[1][0] as string;
      expect(firstUrl).toContain("limit=2");
      expect(firstUrl).not.toContain("before=");
      expect(secondUrl).toContain("before=2");
    });

    it("stops when nextCursor is null after the first page", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        okJson(lifecycleResponse([makeEvent(1)], null)),
      );

      const collected: LifecycleEvent[] = [];
      for await (const event of client.paginateLifecycleEvents("talos-1")) {
        collected.push(event);
      }

      expect(collected).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("respects maxPages to prevent runaway loops", async () => {
      // Always returns another cursor so iteration would be infinite without the cap.
      // Use a factory so each fetch gets a fresh, unconsumed Response body.
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(
          okJson(lifecycleResponse([makeEvent(1)], 1)),
        ),
      );

      const iterator = client.paginateLifecycleEvents("talos-1", { maxPages: 2 });

      await expect(async () => {
        for await (const _ of iterator) {
          // drain
        }
      }).rejects.toThrow("Pagination exceeded maximum page limit of 2");

      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── setLifecycleStatus ─────────────────────────────────────────

  describe("setLifecycleStatus", () => {
    it("sends PATCH /api/talos/:id/status with lifecycleStatus for Active", async () => {
      vi.mocked(fetch).mockResolvedValue(okJson(statusResponse("talos-1", "Active")));

      const result = await client.setLifecycleStatus("talos-1", "Active");

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${BASE_URL}/api/talos/talos-1/status`);
      expect(init.method).toBe("PATCH");

      const body = JSON.parse(init.body as string);
      expect(body.lifecycleStatus).toBe("Active");
      expect(body.governanceApproved).toBeUndefined();

      expect(result).toEqual(statusResponse("talos-1", "Active"));
    });

    it("sends Paused without governanceApproved", async () => {
      vi.mocked(fetch).mockResolvedValue(okJson(statusResponse("talos-1", "Paused")));

      await client.setLifecycleStatus("talos-1", "Paused");

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body as string);
      expect(body.lifecycleStatus).toBe("Paused");
      expect(body.governanceApproved).toBeUndefined();
    });

    it("sends Retired with governanceApproved: true", async () => {
      vi.mocked(fetch).mockResolvedValue(okJson(statusResponse("talos-1", "Retired")));

      await client.setLifecycleStatus("talos-1", "Retired", { governanceApproved: true });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body as string);
      expect(body.lifecycleStatus).toBe("Retired");
      expect(body.governanceApproved).toBe(true);
    });

    it("surfaces TalosForbiddenError when retiring without governanceApproved (403 guard)", async () => {
      // Use a factory so each fetch gets a fresh, unconsumed Response body —
      // the request helper reads res.text(), which locks the body for reuse.
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(errorJson(403, "Retirement requires explicit governance confirmation")),
      );

      // The 403 retirement guard returns a TalosForbiddenError whose
      // `.apiMessage` carries the server's explanation.
      const err = await client
        .setLifecycleStatus("talos-1", "Retired")
        .catch((e) => e);

      expect(err).toBeInstanceOf(TalosForbiddenError);
      expect(err.status).toBe(403);
      expect(err.apiMessage).toBe("Retirement requires explicit governance confirmation");
    });

    it("surfaces TalosForbiddenError when governanceApproved is false", async () => {
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(errorJson(403, "Retirement requires explicit governance confirmation")),
      );

      const err = await client
        .setLifecycleStatus("talos-1", "Retired", { governanceApproved: false })
        .catch((e) => e);

      expect(err).toBeInstanceOf(TalosForbiddenError);
      expect(err.status).toBe(403);
    });

    it("surfaces a generic TalosAPIError for non-403 failures", async () => {
      vi.mocked(fetch).mockResolvedValue(errorJson(404, "TALOS not found"));

      await expect(
        client.setLifecycleStatus("missing", "Active"),
      ).rejects.toThrow(TalosAPIError);
    });
  });

  // ── Compile-time type safety for LifecycleStatus ───────────────

  describe("LifecycleStatus compile-time safety", () => {
    it("LifecycleStatus is a closed union (Active | Paused | Retired)", () => {
      const active: LifecycleStatus = "Active";
      const paused: LifecycleStatus = "Paused";
      const retired: LifecycleStatus = "Retired";

      expect([active, paused, retired]).toEqual(["Active", "Paused", "Retired"]);
    });

    // @ts-expect-error - "active" (lowercase) is not assignable to LifecycleStatus
    const _lowercase: LifecycleStatus = "active";
    // @ts-expect-error - "destroyed" is not a valid LifecycleStatus
    const _unknown: LifecycleStatus = "destroyed";
    // @ts-expect-error - numeric values are not valid LifecycleStatus
    const _number: LifecycleStatus = 42;
  });
});
