"use client";

import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    // Check initial state
    setIsOffline(!navigator.onLine);

    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!isOffline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-0 left-0 right-0 z-50 px-4 py-2 text-center bg-yellow-100 dark:bg-yellow-900/30 border-b border-yellow-300 dark:border-yellow-700"
    >
      <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
        You are offline. Data may be stale.
      </p>
    </div>
  );
}
