import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  MAX_CSP_REPORT_BYTES,
  MAX_REPORTS_PER_BATCH,
  parseCspReports,
} from "@/lib/csp-report";

export const runtime = "nodejs";

/**
 * Receive endpoint for `report-uri` / `report-to` CSP violations emitted
 * while the policy is in `Content-Security-Policy-Report-Only` mode (and for
 * violations hit in enforce mode). See src/lib/security-headers.mjs and
 * src/proxy.ts.
 *
 * Reports are unauthenticated fire-and-forget telemetry: the handler is
 * cheap, size-capped, sanitised in `parseCspReports`, and rate-limited in
 * the proxy under its own `csp-report` bucket. Browsers ignore the response
 * body, so successful intake answers with an empty 204.
 */
export async function POST(request: NextRequest) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSP_REPORT_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const raw = await request.text();
  if (raw.length > MAX_CSP_REPORT_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  const reports = parseCspReports(raw);
  if (reports === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  for (const report of reports.slice(0, MAX_REPORTS_PER_BATCH)) {
    logger.info(report, "csp.violation");
  }

  return new NextResponse(null, { status: 204 });
}
