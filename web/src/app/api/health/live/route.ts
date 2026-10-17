/// <reference types="vitest/importMeta" />
import { NextRequest } from "next/server";
import { withRequestId } from "@/lib/with-request-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function buildLivenessResponse(uptime: number, ts: string) {
  return { status: "ok", uptime, ts };
}

function _GET(_req: NextRequest) {
  return Promise.resolve(
    Response.json(
      buildLivenessResponse(Math.floor(process.uptime()), new Date().toISOString()),
      { status: 200, headers: { "Cache-Control": "no-store" } },
    ),
  );
}

export const GET = withRequestId(_GET);

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("liveness", () => {
    it("returns 200", async () => {
      const res = await GET(new NextRequest("http://localhost/api/health/live"));
      expect(res.status).toBe(200);
    });
  });
}