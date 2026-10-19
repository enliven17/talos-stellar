// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  nextTheme,
  type ThemePreference,
} from "@/lib/theme";

// React reads this flag to know that state updates here are wrapped in act().
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;

function button(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    '[data-testid="theme-toggle"]',
  );
  if (!found) throw new Error("theme toggle is not rendered");
  return found;
}

async function mount() {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(ThemeToggle));
  });
}

async function click() {
  await act(async () => {
    button().click();
  });
}

const preference = () => button().getAttribute("data-theme-preference");
const rootAttribute = () =>
  document.documentElement.getAttribute(THEME_ATTRIBUTE);

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute(THEME_ATTRIBUTE);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("ThemeToggle", () => {
  it("renders as a labelled button that starts on the system preference", async () => {
    await mount();

    expect(button().tagName).toBe("BUTTON");
    expect(button().getAttribute("type")).toBe("button");
    expect(preference()).toBe("system");
    expect(button().getAttribute("aria-label")).toBe(
      "Colour theme: System. Switch to Light.",
    );
    expect(rootAttribute()).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("steps system, light, dark, system and applies each to the page", async () => {
    await mount();

    await click();
    expect(preference()).toBe("light");
    expect(rootAttribute()).toBe("light");
    expect(button().getAttribute("aria-label")).toBe(
      "Colour theme: Light. Switch to Dark.",
    );

    await click();
    expect(preference()).toBe("dark");
    expect(rootAttribute()).toBe("dark");
    expect(button().getAttribute("aria-label")).toBe(
      "Colour theme: Dark. Switch to System.",
    );

    await click();
    expect(preference()).toBe("system");
    expect(rootAttribute()).toBeNull();
  });

  it("persists an explicit choice in localStorage and clears it for system", async () => {
    await mount();

    await click();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await click();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    await click();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("shows a saved choice after a reload", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    await mount();

    expect(preference()).toBe("dark");
    expect(button().getAttribute("aria-label")).toContain("Switch to System");
  });

  it("ignores a saved value it does not recognise", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");

    await mount();

    expect(preference()).toBe("system");
  });

  it("keeps working for the visit when storage throws on every call", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    await mount();

    // The in-memory fallback is module state shared with earlier tests, so the
    // starting point is read rather than assumed.
    const start = preference() as ThemePreference;
    const first = nextTheme(start);
    const second = nextTheme(first);

    await click();
    expect(preference()).toBe(first);
    expect(rootAttribute()).toBe(first === "system" ? null : first);

    await click();
    expect(preference()).toBe(second);
    expect(rootAttribute()).toBe(second === "system" ? null : second);
  });

  it("follows a change made in another tab", async () => {
    await mount();
    expect(preference()).toBe("system");

    await act(async () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });

    expect(preference()).toBe("dark");
  });

  it("renders the same markup on the server as the first client render", () => {
    // Server rendering has no storage; both must start on the system preference
    // so hydration does not mismatch.
    const html = renderToString(createElement(ThemeToggle));
    expect(html).toContain('data-theme-preference="system"');
    expect(html).toContain("Colour theme: System. Switch to Light.");
  });

  it("hides its icon from assistive technology and exposes only the label", async () => {
    await mount();

    const svg = button().querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(button().textContent).toBe("");
    expect(button().getAttribute("title")).toBe(
      button().getAttribute("aria-label"),
    );
  });

  it("stops listening for storage events after it unmounts", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    await mount();

    await act(async () => root.unmount());

    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
    root = createRoot(container);
  });
});
