import { Suspense } from "react";
import { MarketplaceClient } from "./marketplace-client";
import { t } from "@/lib/i18n";

export const metadata = {
  title: t("marketplace.metadata.title"),
  description: t("marketplace.metadata.description"),
};

export default function MarketplacePage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-muted text-sm">
          {t("marketplace.loading")}
        </div>
      }
    >
      <MarketplaceClient />
    </Suspense>
  );
}
