"use client";

import { useEffect } from "react";
import Link from "next/link";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[Error boundary]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <Link href="/" className="text-nav-accent text-4xl font-ruthie mb-10">
        Talos
      </Link>

      <div className="text-xs text-muted mb-4 tracking-wide">// ERROR</div>

      <h1 className="text-2xl font-bold text-accent mb-3">
        Something went wrong
      </h1>

      <p className="text-sm text-muted max-w-sm mb-10 leading-relaxed">
        A transient error occurred. Our team has been notified — please try
        again or return home.
      </p>

      <div className="flex gap-4">
        <button
          onClick={reset}
          className="border border-accent text-accent bg-transparent px-6 py-2.5 text-sm font-medium hover:bg-accent/10 transition-all"
        >
          Try again
        </button>
        <Link
          href="/"
          className="bg-accent text-background px-6 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
