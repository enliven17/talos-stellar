export type LimitResult =
  | { ok: true, limit: number }
  | { ok: false, response: Response };

export function parseLimit(
  value: string | null,
  defaultLimit: number,
  maxLimit: number,
): LimitResult {
  if (value === null) {
    return { ok: true, limit: defaultLimit };
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "Invalid limit" },
        { status: 400 },
      ),
    };
  }
  if (parsed > maxLimit) {
    return {
      ok: false,
      response: Response.json(
        { error: `Limit exceeds maximum of ${maxLimit}` },
        { status: 400 },
      ),
    };
  }
  return { ok: true, limit: parsed };
}

export const ACTIVITY_DEFAULT_LIMIT = 25;
export const ACTIVITY_MAX_LIMIT = 100;

export const LEADERBOARD_DEFAULT_LIMIT = 50;
export const LEADERBOARD_MAX_LIMIT = 100;

export const PROPOSALS_DEFAULT_LIMIT = 50;
export const PROPOSALS_MAX_LIMIT = 100;

export const DASHBOARD_DEFAULT_LIMIT = 20;
export const DASHBOARD_MAX_LIMIT = 100;
