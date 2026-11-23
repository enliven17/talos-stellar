import { describe, it, expect, vi } from "vitest";
import { getCapabilityFilters } from "@/lib/db/services/marketplace";

const mocks = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
}));

vi.mock("@/db", () => ({ db: mocks.mockDb }));

describe("Versioned Capabilities", () => {
  it("getCapabilityFilters returns versioned capabilities", async () => {
    const mockDbRes = [{
      id: "uuid-1",
      name: "Auto",
      version: 2,
      description: "desc",
      category: "cat",
      isActive: true
    }];
    mocks.mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(mockDbRes)
        })
      })
    });

    const filters = await getCapabilityFilters();
    expect(filters[0]).toHaveProperty("version", 2);
  });
});
