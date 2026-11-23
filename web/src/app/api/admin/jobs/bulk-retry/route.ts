import { withRequestId } from "@/lib/with-request-id";
import { NextRequest } from "next/server";
import { verifyAdminKey } from "@/lib/admin-auth";
import {
  executeBulkRetry,
  previewBulkRetry,
  type BulkRetrySelection,
  type RetryClass,
} from "@/lib/jobs";

const VALID_RETRY_CLASSES = new Set<RetryClass>(["transient", "rate_limited", "fatal"]);

interface BulkRetryRequestBody {
  dryRun?: boolean;
  jobIds?: unknown;
  queue?: unknown;
  retryClass?: unknown;
  includeCancelled?: unknown;
  allowFatal?: unknown;
  limit?: unknown;
  selections?: unknown;
}

function parseSelections(raw: unknown): BulkRetrySelection[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed: BulkRetrySelection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { id, revision } = item as { id?: unknown; revision?: unknown };
    if (typeof id !== "string" || !id.trim() || typeof revision !== "string" || !revision.trim()) {
      return null;
    }
    parsed.push({ id, revision });
  }
  return parsed;
}

// POST /api/admin/jobs/bulk-retry — dry-run preview (default) or revision-checked
// bulk retry execution for failed jobs.
async function _POST(request: NextRequest) {
  const auth = verifyAdminKey(request);
  if (!auth.ok) return auth.response;

  let body: BulkRetryRequestBody;
  try {
    body = (await request.json()) as BulkRetryRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const dryRun = body.dryRun ?? true;
  if (typeof dryRun !== "boolean") {
    return Response.json({ error: "dryRun must be a boolean" }, { status: 400 });
  }

  const includeCancelled = body.includeCancelled === true;
  const allowFatal = body.allowFatal === true;

  if (dryRun) {
    if (body.retryClass !== undefined && !VALID_RETRY_CLASSES.has(body.retryClass as RetryClass)) {
      return Response.json(
        { error: `Invalid retryClass "${String(body.retryClass)}"` },
        { status: 400 },
      );
    }

    if (
      body.jobIds !== undefined &&
      (!Array.isArray(body.jobIds) || body.jobIds.some((id) => typeof id !== "string" || !id.trim()))
    ) {
      return Response.json({ error: "jobIds must be an array of non-empty strings" }, { status: 400 });
    }

    if (body.queue !== undefined && typeof body.queue !== "string") {
      return Response.json({ error: "queue must be a string" }, { status: 400 });
    }

    if (
      body.limit !== undefined &&
      (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200)
    ) {
      return Response.json({ error: "limit must be an integer between 1 and 200" }, { status: 400 });
    }

    try {
      const preview = await previewBulkRetry({
        jobIds: body.jobIds as string[] | undefined,
        queue: body.queue as string | undefined,
        retryClass: body.retryClass as RetryClass | undefined,
        includeCancelled,
        allowFatal,
        limit: body.limit as number | undefined,
      });
      return Response.json(preview);
    } catch (err) {
      console.error("[admin/jobs/bulk-retry POST dryRun]", err);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }

  const selections = parseSelections(body.selections);
  if (!selections) {
    return Response.json(
      { error: "selections must be a non-empty array of { id, revision } objects when dryRun is false" },
      { status: 400 },
    );
  }

  try {
    const result = await executeBulkRetry(selections, { includeCancelled, allowFatal });
    const allRevisionConflict =
      result.requeuedCount === 0 &&
      result.skipped.length > 0 &&
      result.skipped.every((item) => item.reason === "revision_mismatch");
    return Response.json(result, { status: allRevisionConflict ? 409 : 200 });
  } catch (err) {
    console.error("[admin/jobs/bulk-retry POST execute]", err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRequestId(_POST);
