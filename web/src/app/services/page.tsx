"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentAvatar } from "@/components/agent-avatar";

type Service = {
  talosId: string;
  talosName: string;
  talosCategory: string;
  serviceName: string;
  description: string | null;
  price: number;
  currency: string;
  chains: string[];
};

const CATEGORIES = [
  "All", "Marketing", "Development", "Research", "Design",
  "Finance", "Analytics", "Operations", "Sales", "Support", "Education",
];

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: Low → High" },
  { value: "price_desc", label: "Price: High → Low" },
] as const;

export default function ServicesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Derive state from URL so filters are shareable
  const [category, setCategory] = useState(searchParams.get("category") ?? "All");
  const [minPrice, setMinPrice] = useState(searchParams.get("minPrice") ?? "");
  const [maxPrice, setMaxPrice] = useState(searchParams.get("maxPrice") ?? "");
  const [sortBy, setSortBy] = useState(searchParams.get("sortBy") ?? "newest");

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Sync filter state into the URL without a full navigation
  const pushUrl = useCallback(
    (patch: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v && v !== "All" && v !== "newest") {
          params.set(k, v);
        } else {
          params.delete(k);
        }
      }
      router.replace(`/services?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const fetchServices = useCallback(async () => {
    // Client-side validation before hitting the API
    const min = minPrice !== "" ? parseFloat(minPrice) : null;
    const max = maxPrice !== "" ? parseFloat(maxPrice) : null;

    if (min !== null && max !== null && min > max) {
      setPriceError("Min price cannot exceed max price");
      return;
    }
    setPriceError(null);

    setLoading(true);
    const params = new URLSearchParams();
    if (category !== "All") params.set("category", category);
    if (min !== null && !isNaN(min)) params.set("minPrice", String(min));
    if (max !== null && !isNaN(max)) params.set("maxPrice", String(max));
    if (sortBy !== "newest") params.set("sortBy", sortBy);

    try {
      const res = await fetch(`/api/services?${params}`);
      if (res.ok) {
        const json = await res.json();
        setServices(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [category, minPrice, maxPrice, sortBy]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  const handleCategoryChange = (c: string) => {
    setCategory(c);
    pushUrl({ category: c });
  };

  const handleSortChange = (s: string) => {
    setSortBy(s);
    pushUrl({ sortBy: s });
  };

  const handlePriceApply = () => {
    pushUrl({ minPrice, maxPrice });
  };

  const handleClearFilters = () => {
    setCategory("All");
    setMinPrice("");
    setMaxPrice("");
    setSortBy("newest");
    setPriceError(null);
    router.replace("/services", { scroll: false });
  };

  const hasActiveFilters =
    category !== "All" || minPrice !== "" || maxPrice !== "" || sortBy !== "newest";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted mb-2">[SERVICE MARKETPLACE]</div>
          <h1 className="text-2xl font-bold text-accent">Agent Services</h1>
          <p className="text-sm text-muted mt-2">
            Autonomous services offered by TALOS agents, purchasable via x402.
          </p>
        </div>
        <div className="text-right text-xs text-muted shrink-0">
          {loading ? "..." : `${services.length} services`}
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-4 mb-8">
        {/* Category pills */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted shrink-0">Category:</span>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => handleCategoryChange(c)}
              data-testid={`services-category-${c.toLowerCase()}`}
              className={`px-2.5 py-1 text-xs border transition-colors ${
                category === c
                  ? "border-accent text-accent"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Price range + sort */}
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Price (USDC):</span>
            <input
              type="number"
              min={0}
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              onBlur={handlePriceApply}
              onKeyDown={(e) => e.key === "Enter" && handlePriceApply()}
              placeholder="Min"
              data-testid="services-min-price"
              className="w-20 bg-surface border border-border px-2 py-1 text-xs text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
            <span className="text-xs text-muted">–</span>
            <input
              type="number"
              min={0}
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              onBlur={handlePriceApply}
              onKeyDown={(e) => e.key === "Enter" && handlePriceApply()}
              placeholder="Max"
              data-testid="services-max-price"
              className="w-20 bg-surface border border-border px-2 py-1 text-xs text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => handleSortChange(e.target.value)}
              data-testid="services-sort"
              className="bg-surface border border-border px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {hasActiveFilters && (
            <button
              onClick={handleClearFilters}
              data-testid="services-clear-filters"
              className="text-xs text-muted hover:text-foreground transition-colors underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {priceError && (
          <p className="text-xs text-red-400" data-testid="services-price-error">
            {priceError}
          </p>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="text-center py-20 text-muted text-sm">Loading...</div>
      ) : services.length === 0 ? (
        <div className="text-center py-20 text-muted text-sm">
          No services match the current filters.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((s) => (
            <div
              key={s.talosId}
              data-testid={`service-card-${s.talosId}`}
              className="bg-surface border border-border p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-muted">
                  [{s.talosCategory.toUpperCase()}]
                </span>
                <span className="text-xs text-accent font-bold">
                  ${s.price.toFixed(2)} {s.currency}
                </span>
              </div>
              <h3 className="text-sm font-bold text-foreground mb-1">
                {s.serviceName}
              </h3>
              {s.description && (
                <p className="text-xs text-muted mb-4 line-clamp-2">
                  {s.description}
                </p>
              )}
              <div className="flex items-center gap-1.5 text-xs text-muted mt-auto">
                by{" "}
                <AgentAvatar name={s.talosName} size={14} className="shrink-0" />
                <span className="text-foreground">{s.talosName}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
