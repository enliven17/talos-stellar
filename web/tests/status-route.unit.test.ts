import { describe, it, expect, vi } from "vitest"; // change if the repo uses jest
import { PATCH } from "@/app/api/talos/[id]/status/route";

// Mock the DB / dependencies the same way other tests in web/tests do.
// vi.mock("@/lib/db", () => ({ ... }));

function makeRequest(body: string) {
  return new Request("http://localhost/api/talos/1/status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  }) as any;
}

const ctx = { params: Promise.resolve({ id: "1" }) };

describe("PATCH /api/talos/[id]/status", () => {
  it("returns 400 for malformed JSON", async () => {
    const res = await PATCH(makeRequest("{not json"), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for wrong type", async () => {
    const res = await PATCH(makeRequest(JSON.stringify({ agentOnline: "yes" })), ctx);
    expect(res.status).toBe(400);
  });

  it("accepts a valid online toggle", async () => {
    const res = await PATCH(makeRequest(JSON.stringify({ agentOnline: true })), ctx);
    expect(res.status).toBe(200);
  });
});