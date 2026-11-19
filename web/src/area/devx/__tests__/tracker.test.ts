import { describe, it, expect } from "vitest";
import { ResourceTracker } from "../tracker";

describe("ResourceTracker", () => {
  it("starts and stops without errors", () => {
    const tracker = new ResourceTracker(50);
    tracker.start();
    const samples = tracker.stop();
    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBeGreaterThanOrEqual(1);
  });

  it("reports memory metrics", () => {
    const tracker = new ResourceTracker(50);
    tracker.start();
    const samples = tracker.stop();
    for (const s of samples) {
      expect(s.memoryMb).toBeGreaterThan(0);
      expect(typeof s.cpuPercent).toBe("number");
      expect(s.timestamp).toBeGreaterThan(0);
    }
  });

  it("getPeakMemory returns max", () => {
    const tracker = new ResourceTracker(50);
    tracker.start();
    tracker.stop();
    const peak = tracker.getPeakMemory();
    expect(peak).toBeGreaterThanOrEqual(0);
  });

  it("getMeanMemory returns average", () => {
    const tracker = new ResourceTracker(50);
    tracker.start();
    tracker.stop();
    const mean = tracker.getMeanMemory();
    expect(mean).toBeGreaterThanOrEqual(0);
  });

  it("collects multiple samples over time", async () => {
    const tracker = new ResourceTracker(20);
    tracker.start();
    await new Promise((r) => setTimeout(r, 100));
    const samples = tracker.stop();
    expect(samples.length).toBeGreaterThanOrEqual(3);
  });
});