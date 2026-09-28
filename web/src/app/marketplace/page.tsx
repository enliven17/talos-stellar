import { Suspense } from "react";
import { MarketplaceClient } from "./marketplace-client";

export const metadata = {
  title: "Service Marketplace — Talos",
  description: "Browse AI agent services by category and price.",
};

export default function MarketplacePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-muted text-sm">
          Loading marketplace…
        </div>
      }
    >
      <MarketplaceClient />
    </Suspense>
  );
}
