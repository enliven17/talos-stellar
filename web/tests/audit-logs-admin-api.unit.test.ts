import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auditLog: { listAuditLogs: vi.fn() },
}));

vi.mock("@/lib/audit-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit-log")>("@/lib/audit-log");
  return {
    ...actual,
    listAuditLogs: mocks.auditLog.listAuditLogs,
  };
});

import { GET as listRoute } from "@/app/api/admin/audit-logs/route";

const ADMIN_KEY = "test-admin-key";

interface Init {
  method?: string;
  headers?: Record<string, string>;
}

function req(path: string, init?: Init) {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

function authed(path: string, init: Init = {}) {
  return req(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${ADMIN_KEY}` } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("admin auth", () => {
  it("returns 500 when ADMIN_API_KEY is not configured", async () => {
    delete process.env.ADMIN_API_KEY;
    expect((await listRoute(req("/api/admin/audit-logs"))).status).toBe(500);
  });

  it("returns 401 with no Authorization header", async () => {
    expect((await listRoute(req("/api/admin/audit-logs"))).status).toBe(401);
  });

  it("returns 403 with a wrong key", async () => {
    const res = await listRoute(
      req("/api/admin/audit-logs", { headers: { authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/audit-logs", () => {
  it("lists logs and passes searchable filters through", async () => {
    mocks.auditLog.listAuditLogs.mockResolvedValue({
      logs: [{ id: "log_1", path: "/api/talos/x/sign", statusCode: 403 }],
      nextCursor: null,
    });

    const res = await listRoute(
      authed(
        "/api/admin/audit-logs?talosId=tal_1&method=POST&q=sign&statusClass=4xx&limit=10",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(mocks.auditLog.listAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        talosId: "tal_1",
        method: "POST",
        q: "sign",
        statusClass: "4xx",
        limit: 10,
      }),
    );
  });

  it("rejects an invalid method filter", async () => {
    const res = await listRoute(authed("/api/admin/audit-logs?method=TRACE"));
    expect(res.status).toBe(400);
    expect(mocks.auditLog.listAuditLogs).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive status filters", async () => {
    const res = await listRoute(
      authed("/api/admin/audit-logs?statusCode=403&statusClass=4xx"),
    );
    expect(res.status).toBe(400);
    expect(mocks.auditLog.listAuditLogs).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected store failure without leaking internals", async () => {
    mocks.auditLog.listAuditLogs.mockRejectedValue(new Error("db down"));
    const res = await listRoute(authed("/api/admin/audit-logs"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toMatch(/db down/);
  });
});
