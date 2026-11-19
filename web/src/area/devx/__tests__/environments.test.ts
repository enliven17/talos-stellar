import { describe, it, expect, vi } from "vitest";
import { MockEnvironmentProvider, formatEnvironmentName } from "../environments";
import * as logger from "../logger";

describe("environments", () => {
  it("formats environment names correctly", () => {
    expect(formatEnvironmentName(123)).toBe("pr-123");
  });

  describe("MockEnvironmentProvider", () => {
    it("provisions an environment", async () => {
      const provider = new MockEnvironmentProvider();
      const meta = await provider.provision(456, "feat/cleanup");
      
      expect(meta.prNumber).toBe(456);
      expect(meta.branch).toBe("feat/cleanup");
      expect(meta.dbUrl).toContain("mock-db.local");
    });

    it("cleans up an environment if status is not destroyed", async () => {
      const provider = new MockEnvironmentProvider();
      
      const teardownSpy = vi.spyOn(provider, "teardown");
      vi.spyOn(provider, "getStatus").mockResolvedValue("ready");

      await provider.cleanup(456);
      expect(teardownSpy).toHaveBeenCalledWith(456);
    });

    it("skips cleanup if status is already destroyed", async () => {
      const provider = new MockEnvironmentProvider();
      
      const teardownSpy = vi.spyOn(provider, "teardown");
      vi.spyOn(provider, "getStatus").mockResolvedValue("destroyed");

      await provider.cleanup(457);
      expect(teardownSpy).not.toHaveBeenCalled();
    });

    it("fails securely without leaking errors", async () => {
      const provider = new MockEnvironmentProvider();
      
      vi.spyOn(provider, "getStatus").mockRejectedValue(new Error("Secret leak error"));

      await expect(provider.cleanup(458)).rejects.toThrow("Failed to safely clean up environment for PR #458. Provider error.");
    });
  });
});
