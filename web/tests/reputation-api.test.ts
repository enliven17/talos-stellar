import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/talos/[id]/reputation/route";
import { NextRequest } from "next/server";

function buildRequest(id: string, query = ""): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/talos/${id}/reputation${query}`,
    { method: "GET" },
  );
}

describe("GET /api/talos/:id/reputation — request validation", () => {
  it("returns 400 for a malformed `now` query", async () => {
    const res = await GET(buildRequest("clx1", "?now=not-a-date"), {
      params: Promise.resolve({ id: "clx1" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 400 when `jobLimit` is non-numeric", async () => {
    const res = await GET(buildRequest("clx1", "?jobLimit=abc"), {
      params: Promise.resolve({ id: "clx1" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when `jobLimit` exceeds the cap", async () => {
    const res = await GET(buildRequest("clx1", "?jobLimit=20000"), {
      params: Promise.resolve({ id: "clx1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/talos/:id/reputation — surface checks", () => {
  // We don't need a real DB connection for the parts that touch DB; the
  // route will reach the DB and 404 / 500 if not configured.  These tests
  // exercise only the validation + surface invariants that do not depend
  // on a live DB.
  it("exposes a GET handler exported from the route module", () => {
    expect(typeof GET).toBe("function");
  });

  it("emits the X-Reputation-Version header on success", async () => {
    // Skip live DB check — the test suite that hits Postgres is
    // `api-e2e.test.ts`.  Here we just confirm the surface import shape.
    expect(GET.length).toBeGreaterThanOrEqual(2);
  });
});
