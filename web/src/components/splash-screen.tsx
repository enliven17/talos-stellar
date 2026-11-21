"use client";

import { useEffect, useState } from "react";

const SESSION_STORAGE_KEY = "talos_splash_shown";

function shouldSkipSplash(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return true;
    }
  } catch {
    // Gracefully handle environments where matchMedia throws
  }

  try {
    if (window.sessionStorage && window.sessionStorage.getItem(SESSION_STORAGE_KEY)) {
      return true;
    }
  } catch {
    // Gracefully handle restricted sessionStorage access
  }

  return false;
}

export function SplashScreen() {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window !== "undefined") {
      return !shouldSkipSplash();
    }
    return true;
  });
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    if (shouldSkipSplash()) {
      setIsVisible(false);
      return;
    }

    try {
      window.sessionStorage?.setItem(SESSION_STORAGE_KEY, "true");
    } catch {
      // Ignore quota or access errors in restricted contexts
    }

    // Phase 1: Show splash for 1.5 seconds
    const exitTimer = setTimeout(() => {
      setIsExiting(true);
    }, 1500);

    // Phase 2: Completely remove after exit animation (0.5s)
    const removeTimer = setTimeout(() => {
      setIsVisible(false);
    }, 2000);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(removeTimer);
    };
  }, []);

  if (!isVisible) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="splash-screen"
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-background transition-opacity duration-500 ease-in-out ${
        isExiting ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-6">
        {/* Core Logo with Ruthie font */}
        <div className="relative">
          <h1 className="text-8xl md:text-9xl font-ruthie text-nav-accent flex gap-x-2">
            {"Talos".split("").map((char, i) => (
              <span
                key={i}
                className="animate-letter-in inline-block text-center"
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                {char}
              </span>
            ))}
          </h1>
          {/* Subtle Pulse effect behind the logo */}
          <div className="absolute inset-0 bg-accent/20 blur-3xl rounded-full scale-150 animate-pulse-subtle -z-10" />
        </div>

        {/* Loading detail */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-48 h-[1px] bg-border overflow-hidden relative">
            <div className="absolute inset-0 bg-accent w-1/3 animate-loading-bar" />
          </div>
          <span className="text-[10px] uppercase tracking-[0.3em] text-muted font-mono animate-pulse">
            Initializing Core
          </span>
        </div>
      </div>
    </div>
  );
}
