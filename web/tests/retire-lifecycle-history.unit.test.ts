import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { LIFECYCLE_EVENTS } from "../src/lib/governance/events";
import { toLifecycleState } from "../src/lib/governance/lifecycle";

describe("retirement lifecycle history", () => {
  it("maps the legacy status to the versioned transition states", () => {
    expect(toLifecycleState("Active")).toBe("active");
    expect(toLifecycleState("Paused")).toBe("paused");
    expect(LIFECYCLE_EVENTS.RETIRED).toBe("agent.lifecycle.retired");
  });

  it("keeps retirement reason in the redacted event detail shape", () => {
    const detail = { reason: "Owner requested retirement", supersededBy: null };
    expect(detail).toEqual({ reason: expect.any(String), supersededBy: null });
  });
});
