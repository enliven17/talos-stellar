// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("../src/components/providers", () => ({
  useStellarWallet: () => ({
    isConnected: false,
    publicKey: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock("../src/components/theme-toggle", () => ({
  ThemeToggle: () => null,
}));

import { Header } from "../src/components/header";

describe("Header mobile menu accessibility", () => {
  it("tracks expanded state and closes on Escape, returning focus to the toggle", () => {
    render(<Header />);

    const toggle = screen.getByTestId("mobile-menu-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("mobile-menu");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("mobile-menu")?.hidden).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("mobile-menu")?.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });
});