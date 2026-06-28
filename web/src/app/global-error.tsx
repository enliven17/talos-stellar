"use client";

import { useEffect } from "react";
import { Ruthie } from "next/font/google";
import "./globals.css";

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

  return (
    <html
      lang="en"
      className={`${ruthie.variable} h-full antialiased`}
      style={{ backgroundColor: "#FCF8F8" }}
    >
      <body
        className="min-h-full flex flex-col items-center justify-center font-mono px-6"
        style={{ backgroundColor: "#FCF8F8", color: "#2D2D2D" }}
      >
        <a
          href="/"
          className="font-ruthie text-4xl mb-10"
          style={{ color: "#F5AFAF" }}
        >
          Talos
        </a>

        <div
          className="text-xs mb-4 tracking-wide"
          style={{ color: "#8E8383" }}
        >
          // CRITICAL ERROR
        </div>

        <h1 className="text-2xl font-bold mb-3" style={{ color: "#F5AFAF" }}>
          Something went wrong
        </h1>

        <p
          className="text-sm max-w-sm mb-10 leading-relaxed text-center"
          style={{ color: "#8E8383" }}
        >
          A critical error occurred while loading the application. Please try
          again or return home.
        </p>

        <div className="flex gap-4">
          <button
            onClick={reset}
            className="px-6 py-2.5 text-sm font-medium transition-all"
            style={{
              border: "1px solid #F5AFAF",
              color: "#F5AFAF",
              background: "transparent",
            }}
          >
            Try again
          </button>
          <a
            href="/"
            className="px-6 py-2.5 text-sm font-medium transition-colors"
            style={{ backgroundColor: "#F5AFAF", color: "#FCF8F8" }}
          >
            Go home
          </a>
        </div>
      </body>
    </html>
  );
}
