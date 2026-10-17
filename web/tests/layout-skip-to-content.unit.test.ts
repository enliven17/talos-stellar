// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import RootLayout from "@/app/layout";

vi.mock("next/font/google", () => ({
  Ruthie: () => ({
    variable: "--font-ruthie",
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("@/components/splash-screen", () => ({
  SplashScreen: () => React.createElement("div", { "data-testid": "splash-screen" }),
}));

vi.mock("@/components/header", () => ({
  Header: () =>
    React.createElement(
      "header",
      { "data-testid": "header" },
      React.createElement("a", { href: "/agents" }, "Agents")
    ),
}));

vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "providers" }, children),
  useStellarWallet: () => ({
    isConnected: false,
    publicKey: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);

  act(() => {
    root?.render(ui);
  });

  return {
    container,
    getByRole: (role: string, options?: { name?: string | RegExp }) => {
      const elements = container.querySelectorAll(
        role === "link"
          ? "a[href]"
          : role === "main"
          ? "main"
          : `[role="${role}"]`
      );
      for (const el of elements) {
        const text = el.textContent || el.getAttribute("aria-label") || "";
        if (!options?.name) return el as HTMLElement;
        if (typeof options.name === "string" && text.includes(options.name)) {
          return el as HTMLElement;
        }
        if (options.name instanceof RegExp && options.name.test(text)) {
          return el as HTMLElement;
        }
      }
      throw new Error(`Unable to find element by role "${role}" with name ${options?.name}`);
    },
    getByText: (textOrRegex: string | RegExp) => {
      const all = container.querySelectorAll("*");
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent?.trim())
          .join(" ");
        if (
          typeof textOrRegex === "string" &&
          (directText === textOrRegex || el.textContent?.trim() === textOrRegex)
        ) {
          return el as HTMLElement;
        }
        if (textOrRegex instanceof RegExp && textOrRegex.test(el.textContent || "")) {
          return el as HTMLElement;
        }
      }
      throw new Error(`Unable to find element by text: ${textOrRegex}`);
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

describe("RootLayout skip-to-content link", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders a visually-hidden-until-focused 'Skip to content' link targeting #main-content", () => {
    const testChild = React.createElement(
      "div",
      { "data-testid": "child-content" },
      "Layout Child Content"
    );

    const { container, getByRole, unmount } = render(
      React.createElement(RootLayout, null, testChild)
    );

    const skipLink = getByRole("link", { name: /skip to content/i });
    expect(skipLink).not.toBeNull();
    expect(skipLink.getAttribute("href")).toBe("#main-content");
    expect(skipLink.textContent?.trim()).toBe("Skip to content");

    // Must be visually hidden until focused
    expect(skipLink.className).toContain("sr-only");
    expect(skipLink.className).toContain("focus:not-sr-only");

    // Target must exist with id main-content and tabIndex -1
    const target = container.querySelector("#main-content");
    expect(target).not.toBeNull();
    expect(target?.tagName.toLowerCase()).toBe("main");
    expect(target?.getAttribute("tabIndex")).toBe("-1");

    // Layout children must be rendered inside the main content target
    const child = target?.querySelector('[data-testid="child-content"]');
    expect(child).not.toBeNull();
    expect(child?.textContent).toBe("Layout Child Content");

    unmount();
  });

  it("ensures the skip link is the first focusable element in the page", () => {
    const testChild = React.createElement("div", null, "Child content");
    const { container, unmount } = render(
      React.createElement(RootLayout, null, testChild)
    );

    const focusable = container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabIndex]:not([tabIndex="-1"])'
    );

    expect(focusable.length).toBeGreaterThan(0);
    expect(focusable[0].textContent?.trim()).toBe("Skip to content");
    expect(focusable[0].getAttribute("href")).toBe("#main-content");

    unmount();
  });

  it("supports moving keyboard focus to the main content container", () => {
    const testChild = React.createElement("div", null, "Child content");
    const { container, unmount } = render(
      React.createElement(RootLayout, null, testChild)
    );

    const mainContent = container.querySelector<HTMLElement>("#main-content");
    expect(mainContent).not.toBeNull();

    mainContent?.focus();
    expect(document.activeElement).toBe(mainContent);

    unmount();
  });
});
