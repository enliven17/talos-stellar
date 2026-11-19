"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Ruthie } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

const ruthie = Ruthie({
  variable: "--font-ruthie",
  subsets: ["latin"],
  weight: "400",
});

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("[Global error boundary]", error);
  }, [error]);

  // This page replaces the root layout, so it repeats the theme script and
  // reads its colours from the same tokens instead of hard-coding the light ones.
  return (
    <html
      lang="en"
      className={`${ruthie.variable} h-full antialiased bg-background`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col items-center justify-center font-mono px-6 bg-background text-foreground">
        <Link href="/" className="font-ruthie text-4xl mb-10 text-accent">
          Talos
        </Link>

        <div className="text-xs mb-4 tracking-wide text-muted">
          {/* CRITICAL ERROR */}
        </div>

        <h1 className="text-2xl font-bold mb-3 text-accent">
          Something went wrong
        </h1>

        <p className="text-sm max-w-sm mb-10 leading-relaxed text-center text-muted">
          A critical error occurred while loading the application. Please try
          again or return home.
        </p>

        <div className="flex gap-4">
          <button
            onClick={reset}
            className="px-6 py-2.5 text-sm font-medium transition-all border border-accent text-accent bg-transparent"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-6 py-2.5 text-sm font-medium transition-colors bg-accent text-background"
          >
            Go home
          </Link>
        </div>
      </body>
    </html>
  );
}
