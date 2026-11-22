import { describe, expect, it } from "vitest";
import {
  deriveServiceAvailability,
  SERVICE_AVAILABILITY_FRESHNESS_MS,
} from "@/lib/marketplace-availability";

const now = new Date("2026-11-18T12:00:00.000Z");

describe("deriveServiceAvailability", () => {
  it("reports a fresh online observation as available", () => {
    expect(
      deriveServiceAvailability(true, new Date(now.getTime() - 60_000), now),
    ).toEqual({
      state: "available",
      freshness: "fresh",
      lastObservedAt: "2026-11-18T11:59:00.000Z",
    });
  });

  it("distinguishes a fresh offline observation from unknown availability", () => {
    expect(
      deriveServiceAvailability(false, new Date(now.getTime() - 60_000), now),
    ).toMatchObject({ state: "unavailable", freshness: "fresh" });
    expect(deriveServiceAvailability(false, null, now)).toEqual({
      state: "unknown",
      freshness: "unknown",
      lastObservedAt: null,
    });
  });

  it("marks an old online observation unavailable and stale", () => {
    expect(
      deriveServiceAvailability(
        true,
        new Date(now.getTime() - SERVICE_AVAILABILITY_FRESHNESS_MS - 1),
        now,
      ),
    ).toMatchObject({ state: "unavailable", freshness: "stale" });
  });
});
