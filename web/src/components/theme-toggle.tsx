"use client";

import { useSyncExternalStore } from "react";
import {
  applyTheme,
  nextTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemePreference,
} from "@/lib/theme";

const LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * What the page remembers when storage is unusable, so the toggle still steps
 * through its states for the rest of the visit.
 */
let memoryTheme: ThemePreference = "system";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // The `storage` event fires in other tabs, which keeps them in step.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getSnapshot(): ThemePreference {
  return readStoredTheme() ?? memoryTheme;
}

// The server and the first client render agree on "system"; the real value is
// read right after hydration without a mismatch.
function getServerSnapshot(): ThemePreference {
  return "system";
}

function choose(theme: ThemePreference): void {
  memoryTheme = theme;
  writeStoredTheme(theme);
  applyTheme(theme, document.documentElement);
  listeners.forEach((listener) => listener());
}

function Icon({ theme }: { theme: ThemePreference }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };

  if (theme === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/**
 * Cycles the colour theme: system, light, dark, system. "System" follows the
 * browser setting and stores nothing; light and dark are saved in localStorage.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const next = nextTheme(theme);
  const label = `Colour theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`;

  return (
    <button
      type="button"
      onClick={() => choose(next)}
      data-testid="theme-toggle"
      data-theme-preference={theme}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center w-8 h-8 shrink-0 border border-border text-muted hover:text-nav-foreground hover:bg-surface-hover transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      <Icon theme={theme} />
    </button>
  );
}
