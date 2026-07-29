export interface AnalyticsPrivacyPolicy {
  minimumCohortSize: number;
  maximumInputRows: number;
}

export const DEFAULT_ANALYTICS_PRIVACY_POLICY: AnalyticsPrivacyPolicy = {
  minimumCohortSize: 5,
  maximumInputRows: 10_000,
};

export class AnalyticsInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsInputValidationError";
  }
}

export interface DeduplicationResult<T> {
  rows: T[];
  duplicateCount: number;
}

/**
 * Bounds each analytics input and removes retry/replay duplicates by an opaque,
 * immutable database key. The key is used only in-memory and is never returned.
 */
export function deduplicateAnalyticsRows<T>(
  rows: readonly T[],
  dataset: string,
  keyOf: (row: T) => string,
  policy: AnalyticsPrivacyPolicy = DEFAULT_ANALYTICS_PRIVACY_POLICY,
): DeduplicationResult<T> {
  if (rows.length > policy.maximumInputRows) {
    throw new AnalyticsInputValidationError(
      `${dataset} exceeds the ${policy.maximumInputRows} row limit`,
    );
  }

  const seen = new Set<string>();
  const distinct: T[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    const key = keyOf(row).trim();
    if (!key) {
      throw new AnalyticsInputValidationError(
        `${dataset} contains a row without an immutable key`,
      );
    }
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    distinct.push(row);
  }

  return { rows: distinct, duplicateCount };
}

export function suppressSparseRecord<T>(
  values: Readonly<Record<string, T>>,
  cohortSizes: Readonly<Record<string, number>>,
  minimumCohortSize = DEFAULT_ANALYTICS_PRIVACY_POLICY.minimumCohortSize,
): { values: Record<string, T>; suppressedCount: number } {
  const visible: Record<string, T> = {};
  let suppressedCount = 0;

  for (const [key, value] of Object.entries(values)) {
    if ((cohortSizes[key] ?? 0) < minimumCohortSize) {
      suppressedCount += 1;
      continue;
    }
    visible[key] = value;
  }

  return { values: visible, suppressedCount };
}

export function suppressSparseRows<T>(
  rows: readonly T[],
  cohortSizeOf: (row: T) => number,
  minimumCohortSize = DEFAULT_ANALYTICS_PRIVACY_POLICY.minimumCohortSize,
): { rows: T[]; suppressedCount: number } {
  const visible: T[] = [];
  let suppressedCount = 0;

  for (const row of rows) {
    if (cohortSizeOf(row) < minimumCohortSize) {
      suppressedCount += 1;
      continue;
    }
    visible.push(row);
  }

  return { rows: visible, suppressedCount };
}

export function describeSuppression(field: string, count: number): string | null {
  if (count === 0) return null;
  return `${field}: ${count} sparse cohort${count === 1 ? "" : "s"} suppressed`;
}
