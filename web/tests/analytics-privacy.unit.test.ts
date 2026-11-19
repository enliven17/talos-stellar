import { describe, expect, it } from "vitest";
import {
  AnalyticsInputValidationError,
  deduplicateAnalyticsRows,
  describeSuppression,
  suppressSparseRecord,
  suppressSparseRows,
} from "../src/lib/analytics-privacy";

describe("analytics privacy", () => {
  it("suppresses values below the cohort boundary without naming them", () => {
    const result = suppressSparseRecord(
      { sparse: 4, visible: 5 },
      { sparse: 4, visible: 5 },
    );

    expect(result).toEqual({
      values: { visible: 5 },
      suppressedCount: 1,
    });
    expect(describeSuppression("supply.byCategory", 1)).toBe(
      "supply.byCategory: 1 sparse cohort suppressed",
    );
  });

  it("applies the same inclusive boundary to sensitive rows", () => {
    const result = suppressSparseRows(
      [
        { id: "hidden", evidence: 4 },
        { id: "visible", evidence: 5 },
      ],
      row => row.evidence,
    );

    expect(result.rows).toEqual([{ id: "visible", evidence: 5 }]);
    expect(result.suppressedCount).toBe(1);
  });

  it("deduplicates retries and rejects unbounded input", () => {
    const replayed = { id: "evt-1" };
    const deduplicated = deduplicateAnalyticsRows(
      Array(100).fill(replayed),
      "events",
      row => row.id,
    );

    expect(deduplicated.rows).toEqual([replayed]);
    expect(deduplicated.duplicateCount).toBe(99);
    expect(() =>
      deduplicateAnalyticsRows(
        [{ id: "1" }, { id: "2" }],
        "events",
        row => row.id,
        { minimumCohortSize: 5, maximumInputRows: 1 },
      ),
    ).toThrow(AnalyticsInputValidationError);
  });

  it("rejects rows without an immutable deduplication key", () => {
    expect(() =>
      deduplicateAnalyticsRows([{ id: "" }], "events", row => row.id),
    ).toThrow("events contains a row without an immutable key");
  });
});
