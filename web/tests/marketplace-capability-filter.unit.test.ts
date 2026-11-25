import { describe, expect, it } from "vitest";
import {
  MAX_CAPABILITY_FILTERS,
  MAX_CAPABILITY_ID_LENGTH,
  marketplaceFilterErrorResponse,
  parseCapabilityFilter,
  validateSupportedCapabilities,
} from "@/lib/marketplace-sort";

describe("parseCapabilityFilter", () => {
  it.each([null, "", "   ", "[]", '["", "  "]', ",,"])(
    "treats %j as no capability filter",
    (raw) => {
      expect(parseCapabilityFilter(raw)).toEqual({ ok: true, capabilityIds: [] });
    },
  );

  it("accepts a JSON array, trimming and de-duplicating in order", () => {
    expect(parseCapabilityFilter('[" cap-b ", "cap-a", "cap-b"]')).toEqual({
      ok: true,
      capabilityIds: ["cap-b", "cap-a"],
    });
  });

  it("keeps accepting a comma-separated list for compatibility", () => {
    expect(parseCapabilityFilter("cap-a, cap-b,,cap-a")).toEqual({
      ok: true,
      capabilityIds: ["cap-a", "cap-b"],
    });
  });

  it.each([
    ['{"id":"cap-a"}', /JSON array/],
    ['"cap-a"', /JSON array/],
    ["[not json", /JSON array of capability IDs or a comma-separated list/],
    ['["cap-a", 7]', /must be strings/],
    ['["cap-a", null]', /must be strings/],
  ])("rejects malformed value %j as invalid_filter", (raw, message) => {
    const result = parseCapabilityFilter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_filter");
    expect(result.error.field).toBe("capabilities");
    expect(result.error.error).toMatch(message);
    expect(result.error).not.toHaveProperty("unsupportedCapabilities");
  });

  it("enforces the per-ID length bound at the boundary", () => {
    const atLimit = "a".repeat(MAX_CAPABILITY_ID_LENGTH);
    expect(parseCapabilityFilter(JSON.stringify([atLimit]))).toEqual({
      ok: true,
      capabilityIds: [atLimit],
    });

    const result = parseCapabilityFilter(JSON.stringify([`${atLimit}a`]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_filter");
  });

  it("enforces the ID count bound at the boundary (after de-duplication)", () => {
    const ids = Array.from({ length: MAX_CAPABILITY_FILTERS }, (_, i) => `cap-${i}`);
    expect(parseCapabilityFilter(JSON.stringify([...ids, ids[0]])).ok).toBe(true);

    const result = parseCapabilityFilter(JSON.stringify([...ids, "cap-extra"]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_filter");
  });
});

describe("validateSupportedCapabilities", () => {
  it("passes supported IDs through unchanged", () => {
    expect(validateSupportedCapabilities(["cap-a"], ["cap-a", "cap-b"])).toEqual({
      ok: true,
      capabilityIds: ["cap-a"],
    });
  });

  it("passes an empty request through (no filter is never unsupported)", () => {
    expect(validateSupportedCapabilities([], [])).toEqual({ ok: true, capabilityIds: [] });
  });

  it("lists every unsupported ID in a typed result", () => {
    const result = validateSupportedCapabilities(["cap-a", "cap-x", "cap-y"], ["cap-a"]);
    expect(result).toEqual({
      ok: false,
      error: {
        error: "Unsupported capability filter: cap-x, cap-y",
        code: "unsupported_capability",
        field: "capabilities",
        fieldErrors: { capabilities: "Unsupported capability filter: cap-x, cap-y" },
        unsupportedCapabilities: ["cap-x", "cap-y"],
      },
    });
  });

  it("matches IDs exactly (case-sensitive)", () => {
    const result = validateSupportedCapabilities(["CAP-A"], ["cap-a"]);
    expect(result.ok).toBe(false);
  });
});

describe("marketplaceFilterErrorResponse", () => {
  it("serializes the typed result as an HTTP 400", async () => {
    const result = validateSupportedCapabilities(["cap-x"], []);
    if (result.ok) throw new Error("expected an unsupported result");
    const res = marketplaceFilterErrorResponse(result.error);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "unsupported_capability" });
  });
});
