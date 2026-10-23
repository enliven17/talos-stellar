// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeroClient } from "@/app/hero-client";

// Configure React act environment for jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("HeroClient component", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let mockCtx: any;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  let observerCallbacks: ((entries: any[], observer: any) => void)[];
  let disconnectMock: () => void;
  let matchMediaListeners: Set<(e: any) => void>;
  let prefersReducedMotionValue: boolean;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    rafCallbacks = new Map();
    nextRafId = 1;
    observerCallbacks = [];
    disconnectMock = vi.fn();
    matchMediaListeners = new Set();
    prefersReducedMotionValue = false;

    mockCtx = {
      fillStyle: "",
      font: "",
      fillRect: vi.fn(),
      fillText: vi.fn(),
      setTransform: vi.fn(),
    };

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type) => {
      if (type === "2d") return mockCtx;
      return null;
    });

    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 300,
      top: 0,
      left: 0,
      bottom: 300,
      right: 400,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });

    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      rafCallbacks.delete(id);
    });

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? prefersReducedMotionValue : false,
      media: query,
      onchange: null,
      addListener: vi.fn((listener) => matchMediaListeners.add(listener)),
      removeListener: vi.fn((listener) => matchMediaListeners.delete(listener)),
      addEventListener: vi.fn((event, listener) => {
        if (event === "change") matchMediaListeners.add(listener);
      }),
      removeEventListener: vi.fn((event, listener) => {
        if (event === "change") matchMediaListeners.delete(listener);
      }),
      dispatchEvent: vi.fn(),
    }));

    class MockIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
      private cb: (entries: any[], observer: any) => void;

      constructor(cb: (entries: any[], observer: any) => void) {
        this.cb = cb;
        observerCallbacks.push(cb);
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn(() => {
        disconnectMock();
        const index = observerCallbacks.indexOf(this.cb);
        if (index !== -1) observerCallbacks.splice(index, 1);
      });
      takeRecords = vi.fn(() => []);
    }

    global.IntersectionObserver = MockIntersectionObserver as any;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("marks the canvas as aria-hidden='true'", () => {
    act(() => {
      root.render(<HeroClient />);
    });
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not schedule animation frames while off-screen, and starts the loop when visible", () => {
    act(() => {
      root.render(<HeroClient />);
    });

    // Off-screen initially: no requestAnimationFrame scheduled
    expect(rafCallbacks.size).toBe(0);

    // Enter viewport via IntersectionObserver
    act(() => {
      observerCallbacks[0]([{ isIntersecting: true }], {} as any);
    });

    // Animation frame is scheduled
    expect(rafCallbacks.size).toBe(1);
    expect(mockCtx.fillRect).not.toHaveBeenCalled();

    // Trigger animation frame step
    const [rafId, cb] = Array.from(rafCallbacks.entries())[0];
    act(() => {
      rafCallbacks.delete(rafId);
      cb(performance.now());
    });

    // Frame rendered and next frame scheduled
    expect(mockCtx.fillRect).toHaveBeenCalled();
    expect(rafCallbacks.size).toBe(1);

    // Leaves viewport
    act(() => {
      observerCallbacks[0]([{ isIntersecting: false }], {} as any);
    });

    // Loop paused: pending frame cancelled
    expect(rafCallbacks.size).toBe(0);

    // Re-enters viewport
    act(() => {
      observerCallbacks[0]([{ isIntersecting: true }], {} as any);
    });

    // Loop resumed
    expect(rafCallbacks.size).toBe(1);
  });

  it("pauses the loop when the tab is hidden and resumes when visible", () => {
    act(() => {
      root.render(<HeroClient />);
    });

    act(() => {
      observerCallbacks[0]([{ isIntersecting: true }], {} as any);
    });
    expect(rafCallbacks.size).toBe(1);

    // Hide tab
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(rafCallbacks.size).toBe(0);

    // Show tab again
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(rafCallbacks.size).toBe(1);
  });

  it("renders a single static frame without scheduling animation loop when reduced motion is preferred", () => {
    prefersReducedMotionValue = true;
    act(() => {
      root.render(<HeroClient />);
    });

    // Even if in viewport, no animation frame should be scheduled
    act(() => {
      observerCallbacks[0]([{ isIntersecting: true }], {} as any);
    });

    expect(rafCallbacks.size).toBe(0);
    // Static frame was rendered
    expect(mockCtx.fillRect).toHaveBeenCalled();
  });

  it("throttles resize events using requestAnimationFrame", () => {
    act(() => {
      root.render(<HeroClient />);
    });

    // Simulate multiple resize events fired synchronously
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });

    // Exactly one resize rAF should be scheduled
    expect(rafCallbacks.size).toBe(1);

    const [resizeRafId, cb] = Array.from(rafCallbacks.entries())[0];
    act(() => {
      rafCallbacks.delete(resizeRafId);
      cb(performance.now());
    });

    // After firing, pending resize rAF is done
    expect(rafCallbacks.size).toBe(0);
  });

  it("cleans up observers, listeners, and pending frames on unmount", () => {
    act(() => {
      root.render(<HeroClient />);
    });

    // Bring on screen to schedule a loop frame
    act(() => {
      observerCallbacks[0]([{ isIntersecting: true }], {} as any);
    });
    // Trigger a resize to schedule a resize frame
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(rafCallbacks.size).toBe(2);

    act(() => {
      root.unmount();
    });

    // All pending frames cancelled on unmount
    expect(rafCallbacks.size).toBe(0);
    // Observer disconnected
    expect(disconnectMock).toHaveBeenCalled();
  });
});
