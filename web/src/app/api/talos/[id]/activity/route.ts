import { NextRequest } from "next/server";
import { db } from "@/db";
import { tlsTalos, tlsActivities } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { verifyAgentApiKey } from "@/lib/auth";
import { parseLimit } from "@/lib/parse-limit";
import { withTraceContext } from "@/lib/tracing";

// ─── Cursor helpers ───────────────────────────────────────────────────────────
//
// The per-agent activity feed is ordered deterministically by
// (createdAt DESC, id DESC).  The cursor encodes both fields so that pages
// never overlap or skip rows even when multiple activities share an identical
// timestamp.
//
// Encoding: base64url(JSON.stringify({ createdAt: ISO-string, id: string }))
// The cursor is opaque to callers — internal fields are never leaked as-is.

type AgentActivityCursor = { createdAt: string; id: string };

export class InvalidAgentActivityCursorError extends Error {
  constructor() {
    super("Invalid cursor");
    this.name = "InvalidAgentActivityCursorError";
  }
}

export function decodeAgentActivityCursor(raw: string): AgentActivityCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<AgentActivityCursor>;

    const date = decoded.createdAt ? new Date(decoded.createdAt) : null;
    if (
      !date ||
      Number.isNaN(date.getTime()) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return { createdAt: date.toISOString(), id: decoded.id };
  } catch {
    throw new InvalidAgentActivityCursorError();
  }
}

export function encodeAgentActivityCursor(cursor: AgentActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

// ─── GET /api/talos/:id/activity ─────────────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const rawCursor = searchParams.get("cursor");
  const parsedLimit = parseLimit(searchParams.get("limit"), 50, 200);
  if (!parsedLimit.ok) return parsedLimit.response;
  const limit = parsedLimit.limit;

  // Validate cursor eagerly — before any DB work — so callers get a clear 400.
  let decodedCursor: AgentActivityCursor | null = null;
  if (rawCursor) {
    try {
      decodedCursor = decodeAgentActivityCursor(rawCursor);
    } catch (err) {
      if (err instanceof InvalidAgentActivityCursorError) {
        return Response.json({ error: "Invalid cursor" }, { status: 400 });
      }
      throw err;
    }
  }

  try {
    const talos = await db
      .select({ id: tlsTalos.id })
      .from(tlsTalos)
      .where(eq(tlsTalos.id, id))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!talos) {
      return Response.json({ error: "TALOS not found" }, { status: 404 });
    }

    // Build WHERE conditions.
    // Ordering is (createdAt DESC, id DESC), so the keyset predicate is:
    //   createdAt < cursorDate
    //   OR (createdAt = cursorDate AND id < cursorId)
    const conditions = [eq(tlsActivities.talosId, id)];
    if (decodedCursor) {
      const cursorDate = new Date(decodedCursor.createdAt);
      conditions.push(
        sql`(${tlsActivities.createdAt} < ${cursorDate}
             OR (${tlsActivities.createdAt} = ${cursorDate}
                 AND ${tlsActivities.id} < ${decodedCursor.id}))`,
      );
    }

    // Fetch limit + 1 to detect whether a next page exists.
    const rows = await db
      .select()
      .from(tlsActivities)
      .where(and(...conditions))
      .orderBy(desc(tlsActivities.createdAt), desc(tlsActivities.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const activities = hasMore ? rows.slice(0, limit) : rows;

    const lastItem = activities[activities.length - 1];
    const nextCursor =
      hasMore && lastItem
        ? encodeAgentActivityCursor({
            createdAt: lastItem.createdAt.toISOString(),
            id: lastItem.id,
          })
        : null;

    return Response.json({ activities, nextCursor });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/talos/:id/activity — Report activity (from Local Agent)
async function handlePost(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const auth = await verifyAgentApiKey(request, id, ["activity:write"]);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { type, content, channel, status } = body;

    const validTypes = ["post", "research", "reply", "commerce", "approval"];
    const validStatuses = ["completed", "pending", "failed"];

    if (!type || !content || !channel) {
      return Response.json(
        { error: "type, content, channel are required" },
        { status: 400 }
      );
    }

    if (!validTypes.includes(type)) {
      return Response.json(
        { error: `type must be one of: ${validTypes.join(", ")}` },
        { status: 400 }
      );
    }

    if (status && !validStatuses.includes(status)) {
      return Response.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    // Check quota BEFORE writing to DB so we never persist a record that
    // would be rejected.  This also avoids orphaned rows when quota is exceeded.
    const quotaResult = await checkAndIncrementQuota(db, id, "activity_writes");
    if (!quotaResult.ok) return quotaExceededResponse(quotaResult);

    const [activity] = await db
      .insert(tlsActivities)
      .values({
        talosId: id,
        type,
        content,
        channel,
        status: status ?? "completed",
      })
      .returning();

    // Fire webhook event (non-blocking)
    emitWebhookEvent({
      type: `activity.${type}`,
      talosId: id,
      payload: {
        activityId: activity.id,
        type,
        channel,
        status: activity.status,
      },
    }).catch(() => {});

    return Response.json(activity, { status: 201 });
  } catch {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withTraceContext(handlePost);
