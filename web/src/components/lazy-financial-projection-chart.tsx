"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

// ─── Skeleton placeholder ──────────────────────────────────────────
//
// Shown while the chart chunk is loading or before the section is
// scrolled into view. Mirrors the layout of the real chart so there
// is no layout shift (CLS = 0).

function ChartSkeleton() {
  return (
    <div className="bg-surface border border-border p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-4 w-48 bg-border rounded" />
        <div className="h-[300px] bg-border/60 rounded" />
        <div className="h-4 w-32 bg-border rounded" />
        <div className="h-[250px] bg-border/60 rounded" />
      </div>
    </div>
  );
}

// ─── Lazy chart ───────────────────────────────────────────────────
//
// next/dynamic with ssr:false keeps Recharts out of the server bundle
// and the initial client bundle. The chunk is only fetched when the
// projection section enters the viewport.

const FinancialProjectionChart = dynamic(
  () => import("@/components/financial-projection-chart").then((m) => m.FinancialProjectionChart),
  {
    ssr: false,
    loading: () => <ChartSkeleton />,
  },
);

interface LazyFinancialProjectionChartProps {
  talosId: string;
}

export function LazyFinancialProjectionChart({ talosId }: LazyFinancialProjectionChartProps) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  // Only render the chart (and trigger its data fetch) once the
  // section is scrolled into view. This defers the projection API
  // call and the Recharts chunk download until the user actually
  // needs it.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;

    // If the browser doesn't support IntersectionObserver, fall back
    // to rendering immediately.
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={sectionRef}>
      {visible ? (
        <FinancialProjectionChart talosId={talosId} />
      ) : (
        <ChartSkeleton />
      )}
    </div>
  );
}
