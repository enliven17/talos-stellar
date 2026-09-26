import { describe, expect, it } from "vitest";
import { AGENTS_LIST_TAG, agentMutationTags, agentTag } from "./cache-tags";

describe("cache-tags", () => {
  it("builds a stable per-agent tag", () => {
    expect(agentTag("abc-123")).toBe("agents:id:abc-123");
  });

  it("rejects missing / blank ids", () => {
    expect(() => agentTag("")).toThrow(/non-empty|required/i);
    expect(() => agentTag("   ")).toThrow(/non-empty/i);
  });

  it("includes list + detail tags for mutations", () => {
    expect(agentMutationTags("x")).toEqual([AGENTS_LIST_TAG, "agents:id:x"]);
  });
});
