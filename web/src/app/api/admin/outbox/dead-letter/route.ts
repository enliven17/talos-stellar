import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import { logger } from "@/lib/logger";
import { listEvents, summarizeDeadLetters } from "@/lib/outbox";
import { parseDeadLetterQuery, toDeadLetterView } from "@/lib/outbox/dead-letter";
import { truncateError } from "@/lib/outbox/metrics";

// GET /api/admin/outbox/dead-letter — operator view of failed deliveries.
//
// Same data as GET /api/admin/outbox?status=dead_letter, but projected to a
// privacy-safe triage shape (no payload / dedupeKey / lease fields, sanitized
// lastError), with strict query validation and a per-eventType backlog
// summary. Requeue an event with POST /api/admin/outbox/:id/retry.
export async function GET(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  const parsed = parseDeadLetterQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { eventType, cursor, limit } = parsed.query;

  try {
    const [{ events, nextCursor }, summary] = await Promise.all([
      listEvents({ status: "dead_letter", eventType, cursor, limit }),
      summarizeDeadLetters(),
    ]);

    return Response.json(
      { deadLetters: events.map(toDeadLetterView), nextCursor, summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // Log a bounded message only — never the raw error object, which for a
    // driver error can include bound query parameters.
    logger.error({ err: truncateError(err) }, "admin_outbox_dead_letter_error");
    return Response.json({ error: "Failed to load dead-letter events" }, { status: 503 });
  }
}
