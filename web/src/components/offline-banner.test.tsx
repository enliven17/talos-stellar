import { render, screen, act, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { OfflineBanner } from "./offline-banner";

describe("OfflineBanner", () => {
  beforeEach(() => {
    // Reset to online state before each test
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: true,
    });
  });

  afterEach(() => {
    // Clean up any event listeners
    window.dispatchEvent(new Event("online"));
  });

  it("does not render when online", () => {
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: true,
    });

    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders when offline", () => {
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: false,
    });

    render(<OfflineBanner />);

    const banner = screen.getByRole("status");
    expect(banner).toBeDefined();
    expect(banner.textContent).toContain("You are offline. Data may be stale.");
  });

  it("disappears when coming back online", async () => {
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: false,
    });

    const { container } = render(<OfflineBanner />);

    // Should be visible initially
    expect(screen.getByRole("status")).toBeDefined();

    // Simulate coming back online
    act(() => {
      Object.defineProperty(navigator, "onLine", {
        writable: true,
        value: true,
      });
      window.dispatchEvent(new Event("online"));
    });

    // Should disappear
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("appears when going offline", async () => {
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: true,
    });

    const { container } = render(<OfflineBanner />);

    // Should not be visible initially
    expect(container.firstChild).toBeNull();

    // Simulate going offline
    act(() => {
      Object.defineProperty(navigator, "onLine", {
        writable: true,
        value: false,
      });
      window.dispatchEvent(new Event("offline"));
    });

    // Should appear
    await waitFor(() => {
      const banner = screen.getByRole("status");
      expect(banner).toBeDefined();
      expect(banner.textContent).toContain("You are offline. Data may be stale.");
    });
  });

  it("has accessible role and aria-live attributes", () => {
    Object.defineProperty(navigator, "onLine", {
      writable: true,
      value: false,
    });

    render(<OfflineBanner />);

    const banner = screen.getByRole("status");
    expect(banner.getAttribute("aria-live")).toBe("polite");
  });
});
