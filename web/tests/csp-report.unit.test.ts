/**
 * Coverage for the CSP violation intake endpoint (POST /api/csp-report) and
 * the sanitising parser behind it (src/lib/csp-report.ts).
 *
 * Reports are unauthenticated input, so the assertions below pin down both
 * the transport contract (204/400/413) and the sanitisation guarantees
 * (query stripping, control characters, truncation, batch caps).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { POST } from "@/app/api/csp-report/route";
import { logger } from "@/lib/logger";
import {
  MAX_CSP_REPORT_BYTES,
  MAX_REPORTS_PER_BATCH,
  parseCspReports,
} from "@/lib/csp-report";

function makeReportRequest(
  body: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/csp-report", {
    method: "POST",
    headers: {
      "content-type": "application/csp-report",
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Parser (src/lib/csp-report.ts) ────────────────────────────────

describe("parseCspReports", () => {
  it("reads the legacy report-uri envelope", () => {
    const raw = JSON.stringify({
      "csp-report": {
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "document-uri": "https://app.example/dashboard",
        "blocked-uri": "https://cdn.evil.example/x.js",
        "source-file": "https://app.example/_next/static/chunks/app.js",
        "line-number": "12",
        "column-number": "34",
      },
    });

    expect(parseCspReports(raw)).toEqual([
      {
        directive: "script-src-elem",
        document: "https://app.example/dashboard",
        blocked: "https://cdn.evil.example/x.js",
        source: "https://app.example/_next/static/chunks/app.js",
        line: 12,
        column: 34,
      },
    ]);
  });

  it("reads the report-to application/reports+json envelope", () => {
    const raw = JSON.stringify([
      {
        type: "csp-violation",
        url: "https://app.example/dashboard",
        user_agent: "test-agent",
        body: {
          "violated-directive": "connect-src",
          "document-uri": "https://app.example/dashboard",
          "blocked-uri": "https://unexpected.example/socket",
        },
      },
    ]);

    const reports = parseCspReports(raw);
    expect(reports).toHaveLength(1);
    expect(reports?.[0]).toMatchObject({
      directive: "connect-src",
      blocked: "https://unexpected.example/socket",
    });
  });

  it("reads a bare report object", () => {
    const raw = JSON.stringify({
      "violated-directive": "style-src-elem",
      "blocked-uri": "inline",
    });

    expect(parseCspReports(raw)).toEqual([
      {
        directive: "style-src-elem",
        document: null,
        blocked: "inline",
        source: null,
        line: null,
        column: null,
      },
    ]);
  });

  it("returns null for invalid JSON so the route can reject it", () => {
    expect(parseCspReports("{not json")).toBeNull();
    expect(parseCspReports("")).toBeNull();
    expect(parseCspReports("[1, 2")).toBeNull();
  });

  it("returns an empty list for JSON without CSP reports", () => {
    expect(parseCspReports("{}")).toEqual([]);
    expect(parseCspReports(JSON.stringify({ hello: "world" }))).toEqual([]);
    expect(parseCspReports(JSON.stringify([]))).toEqual([]);
    expect(parseCspReports(JSON.stringify("just a string"))).toEqual([]);
  });

  it("strips query strings and fragments from URL fields", () => {
    const raw = JSON.stringify({
      "csp-report": {
        "violated-directive": "connect-src",
        "document-uri": "https://app.example/page?session=super-secret#top",
        "blocked-uri": "https://api.example/v1/data?token=abc123",
      },
    });

    const [report] = parseCspReports(raw) ?? [];
    expect(report.document).toBe("https://app.example/page");
    expect(report.blocked).toBe("https://api.example/v1/data");
  });

  it("collapses control characters and truncates oversized fields", () => {
    const raw = JSON.stringify({
      "csp-report": {
        "violated-directive": "script-src-elem\r\nX-Injected: 1",
        "blocked-uri": `https://evil.example/${"a".repeat(1000)}`,
      },
    });

    const [report] = parseCspReports(raw) ?? [];
    expect(report.directive).toBe("script-src-elem X-Injected: 1");
    expect(report.directive).not.toMatch(/[\r\n]/);
    expect(report.blocked!.length).toBeLessThanOrEqual(303);
    expect(report.blocked!.endsWith("...")).toBe(true);
  });

  it("keeps opaque sources diagnosable (data:, blob:, inline)", () => {
    const raw = JSON.stringify([
      { "csp-report": { "blocked-uri": "data:text/html,<script>alert(1)</script>" } },
      { "csp-report": { "blocked-uri": "blob:https://app.example/uuid" } },
      { "csp-report": { "blocked-uri": "inline" } },
    ]);

    const reports = parseCspReports(raw) ?? [];
    expect(reports[0].blocked).toBe("data:");
    expect(reports[1].blocked).toBe("https://app.example/uuid");
    expect(reports[2].blocked).toBe("inline");
  });

  it("caps how many reports one batch can yield", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      "csp-report": {
        "violated-directive": `script-src ${i}`,
        "document-uri": `https://app.example/page-${i}`,
      },
    }));

    const reports = parseCspReports(JSON.stringify(entries));
    expect(reports).toHaveLength(MAX_REPORTS_PER_BATCH);
  });
});

// ─── Route (POST /api/csp-report) ─────────────────────────────────

describe("POST /api/csp-report", () => {
  it("accepts a legacy report with a 204 and logs a sanitised summary", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "violated-directive": "script-src-elem",
        "document-uri": "https://app.example/dashboard?session=abc",
        "blocked-uri": "https://evil.example/x.js?token=secret",
        "line-number": "7",
      },
    });

    const res = await POST(makeReportRequest(body));

    expect(res.status).toBe(204);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        directive: "script-src-elem",
        document: "https://app.example/dashboard",
        blocked: "https://evil.example/x.js",
        line: 7,
      }),
      "csp.violation",
    );
  });

  it("accepts a report-to batch", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          "violated-directive": "connect-src",
          "document-uri": "https://app.example/leaderboard",
          "blocked-uri": "https://unknown.example",
        },
      },
    ]);

    const res = await POST(
      makeReportRequest(body, {
        "content-type": "application/reports+json",
      }),
    );

    expect(res.status).toBe(204);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ directive: "connect-src" }),
      "csp.violation",
    );
  });

  it("rejects invalid JSON with a 400 and logs nothing", async () => {
    const res = await POST(makeReportRequest("{definitely not json"));

    expect(res.status).toBe(400);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("answers 204 without logging when the payload has no CSP reports", async () => {
    const res = await POST(makeReportRequest(JSON.stringify({ hello: "world" })));

    expect(res.status).toBe(204);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies advertised via content-length", async () => {
    const res = await POST(
      makeReportRequest("{}", {
        "content-length": String(MAX_CSP_REPORT_BYTES + 1),
      }),
    );

    expect(res.status).toBe(413);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies without a content-length header", async () => {
    const oversized = JSON.stringify({
      "csp-report": {
        "violated-directive": "script-src-elem",
        "blocked-uri": `https://evil.example/${"a".repeat(MAX_CSP_REPORT_BYTES)}`,
      },
    });
    expect(oversized.length).toBeGreaterThan(MAX_CSP_REPORT_BYTES);

    const res = await POST(makeReportRequest(oversized));

    expect(res.status).toBe(413);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs at most one line per report in a batch", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      "csp-report": {
        "violated-directive": `img-src ${i}`,
        "document-uri": `https://app.example/page-${i}`,
      },
    }));

    const res = await POST(makeReportRequest(JSON.stringify(entries)));

    expect(res.status).toBe(204);
    expect(logger.info).toHaveBeenCalledTimes(MAX_REPORTS_PER_BATCH);
  });
});
