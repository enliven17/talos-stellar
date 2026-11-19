"use client";

import { useState, useCallback, useRef, type ReactNode } from "react";

/**
 * Copy text to the clipboard.
 *
 * Uses the async Clipboard API (`navigator.clipboard.writeText`) when
 * available and falls back to a hidden-textarea + `document.execCommand`
 * approach for older browsers / non-secure contexts.
 *
 * Resolves to `true` when the value was placed on the clipboard, `false`
 * otherwise.  Never rejects — callers can treat the boolean as the source
 * of truth without try/catch.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  // ── Preferred: async Clipboard API ───────────────────────────
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to legacy path
    }
  }

  // ── Fallback: hidden textarea + execCommand("copy") ──────────
  if (typeof document !== "undefined") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}

export interface CopyButtonProps {
  /** The full value to place on the clipboard (not the truncated one). */
  value: string;
  /** Accessible label read by screen readers, e.g. "Copy wallet address". */
  label: string;
  /** Optional inline label shown next to the icon when not confirmed. */
  inlineLabel?: ReactNode;
  /** Confirmation text announced + shown briefly after a successful copy. */
  confirmText?: string;
  /** Visual size variant. */
  size?: "sm" | "md";
  /** Extra className for the button element. */
  className?: string;
  /** Disable the button (e.g. when there is nothing to copy). */
  disabled?: boolean;
}

/**
 * A small, accessible copy-to-clipboard button.
 *
 * - Places the **full** `value` on the clipboard (never a truncated string).
 * - Announces the confirmation via an `aria-live` region so screen-reader
 *   users hear "Copied!" without moving focus.
 * - Falls back to `document.execCommand("copy")` when the async Clipboard
 *   API is unavailable (non-secure context / older browser).
 */
export function CopyButton({
  value,
  label,
  inlineLabel,
  confirmText = "Copied!",
  size = "sm",
  className = "",
  disabled = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    if (disabled || !value) return;
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [value, disabled]);

  const sizeClasses =
    size === "sm" ? "text-xs px-1.5 py-0.5" : "text-sm px-2 py-1";

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        onClick={handleCopy}
        disabled={disabled || !value}
        aria-label={copied ? confirmText : label}
        data-testid="copy-button"
        data-copied={copied ? "true" : "false"}
        className={`inline-flex items-center gap-1 border border-border text-muted hover:text-accent hover:border-accent transition-colors ${sizeClasses} ${className}`.trim()}
      >
        {copied ? (
          <span aria-hidden="true">&#10003;</span>
        ) : (
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
        {inlineLabel && !copied ? (
          <span>{inlineLabel}</span>
        ) : copied ? (
          <span aria-hidden="true">{confirmText}</span>
        ) : null}
      </button>
      {/* Polite live region — announces confirmation to AT users */}
      <span
        role="status"
        aria-live="polite"
        data-testid="copy-button-status"
        className="sr-only"
      >
        {copied ? confirmText : ""}
      </span>
    </span>
  );
}
