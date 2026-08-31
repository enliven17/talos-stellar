export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function buildLivenessResponse(uptime: number, ts: string) {
  return { status: "ok", uptime, ts };
}
export function GET() {
  return Response.json(
    buildLivenessResponse(Math.floor(process.uptime()), new Date().toISOString()),
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("liveness", () => {
    it("returns 200", async () => {
      const res = GET();
      expect(res.status).toBe(200);
    });
  });
}