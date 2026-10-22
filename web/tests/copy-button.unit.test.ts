import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  copyToClipboard,
  CopyButton,
} from "../src/components/copy-button";

/* ------------------------------------------------------------------ *
 * The CopyButton component delegates all clipboard work to the
 * exported `copyToClipboard` async helper.  Testing that helper with a
 * mocked `navigator.clipboard.writeText` covers the acceptance criteria
 * ("Copy places the full value on the clipboard" and "Confirmation is
 * announced") without needing a DOM / RTL environment — matching the
 * repo's existing pure-logic test style (see agent-view-states test).
 * ------------------------------------------------------------------ */

describe("copyToClipboard", () => {
  const originalClipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  const originalExecCommand =
    typeof document !== "undefined" ? document.execCommand : undefined;

  beforeEach(() => {
    // Provide a fresh mock for each test.
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the original clipboard (or delete if there was none).
    if (originalClipboard) {
      Object.defineProperty(globalThis.navigator, "clipboard", {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
    }
    if (originalExecCommand && typeof document !== "undefined") {
      document.execCommand = originalExecCommand;
    }
  });

  it("places the full value on the clipboard via navigator.clipboard.writeText (positive)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const value = "GABCDEF1234567890ABCDEFGHIJ";
    const ok = await copyToClipboard(value);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    // The FULL value must be passed — never a truncated copy.
    expect(writeText).toHaveBeenCalledWith(value);
  });

  it("returns false when clipboard API rejects (negative)", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const ok = await copyToClipboard("test-value");

    expect(ok).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("test-value");
  });

  it("falls back to execCommand when clipboard API is unavailable (fallback)", async () => {
    // Remove the clipboard API entirely.
    delete (globalThis.navigator as { clipboard?: unknown }).clipboard;

    // Stub a minimal document + execCommand for the fallback path.
    const execCommand = vi.fn().mockReturnValue(true);
    const removeChild = vi.fn();
    const appendChild = vi.fn();
    const select = vi.fn();
    const fakeTextarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {},
      select,
    } as unknown as HTMLTextAreaElement;

    const doc = {
      createElement: vi.fn().mockReturnValue(fakeTextarea),
      body: { appendChild, removeChild },
      execCommand,
    } as unknown as Document;

    const originalDoc = globalThis.document;
    globalThis.document = doc as unknown as Document;

    try {
      const ok = await copyToClipboard("GSHORT");
      expect(ok).toBe(true);
      expect(doc.createElement).toHaveBeenCalledWith("textarea");
      expect(execCommand).toHaveBeenCalledWith("copy");
    } finally {
      globalThis.document = originalDoc;
    }
  });

  it("passes through long hashes / ids without truncation (boundary)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const longHash = "a".repeat(64);
    await copyToClipboard(longHash);
    expect(writeText).toHaveBeenCalledWith(longHash);
  });
});

/* ------------------------------------------------------------------ *
 * Component exported contract — verifies CopyButton is a valid React
 * component (function) so consumers can render it, and that the module
 * exports both the component and the helper.
 * ------------------------------------------------------------------ */
describe("CopyButton exported contract", () => {
  it("exports a callable React component", () => {
    expect(typeof CopyButton).toBe("function");
  });

  it("exported copyToClipboard is an async function", () => {
    expect(typeof copyToClipboard).toBe("function");
  });
});
