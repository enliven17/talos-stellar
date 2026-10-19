// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SplashScreen } from "@/components/splash-screen";

/**
 * RTL-compatible render harness for React 19 in JSDOM.
 */
function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);

  act(() => {
    root?.render(ui);
  });

  return {
    container,
    getByTestId: (testId: string) => {
      const el = container.querySelector(`[data-testid="${testId}"]`);
      if (!el) {
        throw new Error(`Unable to find element by [data-testid="${testId}"]`);
      }
      return el as HTMLElement;
    },
    queryByTestId: (testId: string) => {
      return container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
    },
    unmount: () => {
      act(() => {
        root?.unmount();
        root = null;
      });
      container.remove();
    },
  };
}

function mockMatchMedia(matches: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce") ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("SplashScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
    document.body.innerHTML = "";
  });

  describe("prefers-reduced-motion: reduce", () => {
    it("does not render the overlay when reduced motion is preferred", () => {
      window.matchMedia = mockMatchMedia(true);

      const { queryByTestId, unmount } = render(React.createElement(SplashScreen));

      expect(queryByTestId("splash-screen")).toBeNull();
      unmount();
    });

    it("does not schedule exit or removal timers when reduced motion is preferred", () => {
      window.matchMedia = mockMatchMedia(true);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const { queryByTestId, unmount } = render(React.createElement(SplashScreen));

      expect(queryByTestId("splash-screen")).toBeNull();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe("prefers-reduced-motion: no-preference (motion allowed)", () => {
    it("renders the overlay with aria-hidden=true", () => {
      window.matchMedia = mockMatchMedia(false);

      const { getByTestId, unmount } = render(React.createElement(SplashScreen));

      const overlay = getByTestId("splash-screen");
      expect(overlay).not.toBeNull();
      expect(overlay.getAttribute("aria-hidden")).toBe("true");

      unmount();
    });

    it("animates exit at 1.5s and removes from DOM at 2.0s", () => {
      window.matchMedia = mockMatchMedia(false);

      const { getByTestId, queryByTestId, unmount } = render(React.createElement(SplashScreen));

      const overlay = getByTestId("splash-screen");
      expect(overlay.className).toContain("opacity-100");

      // Advance to exit phase (1.5s)
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(overlay.className).toContain("opacity-0");
      expect(overlay.className).toContain("pointer-events-none");

      // Advance to full removal phase (2.0s total)
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(queryByTestId("splash-screen")).toBeNull();

      unmount();
    });
  });

  describe("sessionStorage behavior", () => {
    it("sets session storage once displayed and skips rendering on repeat mounts", () => {
      window.matchMedia = mockMatchMedia(false);

      // First mount: splash displays and sets session key
      const first = render(React.createElement(SplashScreen));
      expect(first.getByTestId("splash-screen")).not.toBeNull();
      expect(sessionStorage.getItem("talos_splash_shown")).toBe("true");
      first.unmount();

      // Second mount: splash is skipped because session storage key exists
      const second = render(React.createElement(SplashScreen));
      expect(second.queryByTestId("splash-screen")).toBeNull();
      second.unmount();
    });

    it("handles sessionStorage access throwing gracefully without crashing", () => {
      window.matchMedia = mockMatchMedia(false);

      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError: Access denied");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      const { getByTestId, unmount } = render(React.createElement(SplashScreen));
      expect(getByTestId("splash-screen")).not.toBeNull();
      unmount();
    });
  });

  describe("resilience", () => {
    it("handles missing or throwing matchMedia gracefully", () => {
      // @ts-expect-error simulating environment where matchMedia is not implemented
      delete window.matchMedia;

      const { getByTestId, unmount } = render(React.createElement(SplashScreen));
      expect(getByTestId("splash-screen")).not.toBeNull();
      unmount();
    });
  });
});
