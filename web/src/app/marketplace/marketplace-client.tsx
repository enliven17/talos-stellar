"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  startTransition,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentAvatar } from "@/components/agent-avatar";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SERVICE_CATEGORIES = [
  "All",
  "Marketing",
  "Development",
  "Research",
  "Design",
  "Finance",
  "Analytics",
  "Operations",
  "Sales",
  "Support",
  "Education",
] as const;

export const SORT_OPTIONS = [
  { value: "", label: "Newest first" },
  { value: "price:asc", label: "Price: Low → High" },
  { value: "price:desc", label: "Price: High → Low" },
  { value: "createdAt:asc", label: "Oldest first" },
] as const;

// ---------------------------------------------------------------------------
// URL ↔ filter helpers
// ---------------------------------------------------------------------------

function buildApiUrl(params: {
  category: string;
  minPrice: string;
  maxPrice: string;
  sort: string;
  cursor?: string | null;
}): string {
  const sp = new URLSearchParams();
  if (params.category && params.category !== "All")
    sp.set("category", params.category);
  if (params.minPrice) sp.set("minPrice", params.minPrice);
  if (params.maxPrice) sp.set("maxPrice", params.maxPrice);
  if (params.sort) {
    const [field, direction] = params.sort.split(":");
    if (field) sp.set("sort", field);
    if (direction) sp.set("direction", direction);
  }
  if (params.cursor) sp.set("cursor", params.cursor);
  sp.set("limit", "24");
  return `/api/services?${sp.toString()}`;
}

function buildPageUrl(params: {
  category: string;
  minPrice: string;
  maxPrice: string;
  sort: string;
}): string {
  const sp = new URLSearchParams();
  if (params.category && params.category !== "All")
    sp.set("category", params.category);
  if (params.minPrice) sp.set("minPrice", params.minPrice);
  if (params.maxPrice) sp.set("maxPrice", params.maxPrice);
  if (params.sort) sp.set("sort", params.sort);
  const qs = sp.toString();
  return qs ? `/marketplace?${qs}` : "/marketplace";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarketplaceClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── Derive filter state from URL ─────────────────────────────────────────
  const urlCategory = searchParams.get("category") ?? "All";
  const urlMinPrice = searchParams.get("minPrice") ?? "";
  const urlMaxPrice = searchParams.get("maxPrice") ?? "";
  const urlSort = searchParams.get("sort") ?? "";

  // ── Local draft state for price inputs (committed on blur / Enter) ────────
  const [draftMin, setDraftMin] = useState(urlMinPrice);
  const [draftMax, setDraftMax] = useState(urlMaxPrice);
  const [priceError, setPriceError] = useState<string | null>(null);

  // Keep drafts in sync when URL changes (e.g. back/forward navigation)
  useEffect(() => {
    setDraftMin(urlMinPrice);
    setDraftMax(urlMaxPrice);
    setPriceError(null);
  }, [urlMinPrice, urlMaxPrice]);

  // ── Data state ────────────────────────────────────────────────────────────
  const [services, setServices] = useState<Service[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Ref to abort stale fetches when filters change ────────────────────────
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch helpers ─────────────────────────────────────────────────────────
  const fetchFirstPage = useCallback(
    async (category: string, minPrice: string, maxPrice: string, sort: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setFetchError(null);
      setServices([]);
      setNextCursor(null);

      try {
        const url = buildApiUrl({ category, minPrice, maxPrice, sort });
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setFetchError(body.error ?? "Failed to load services.");
          return;
        }
        const json = (await res.json()) as {
          data: Service[];
          nextCursor: string | null;
        };
        setServices(json.data);
        setNextCursor(json.nextCursor);
      } catch (err) {
        if ((err as { name?: string }).name !== "AbortError") {
          setFetchError("Failed to load services.");
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const fetchNextPage = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const url = buildApiUrl({
        category: urlCategory,
        minPrice: urlMinPrice,
        maxPrice: urlMaxPrice,
        sort: urlSort,
        cursor: nextCursor,
      });
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as {
        data: Service[];
        nextCursor: string | null;
      };
      setServices((prev) => [...prev, ...json.data]);
      setNextCursor(json.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, urlCategory, urlMinPrice, urlMaxPrice, urlSort]);

  // ── Re-fetch when URL-derived params change ───────────────────────────────
  useEffect(() => {
    startTransition(() => {
      fetchFirstPage(urlCategory, urlMinPrice, urlMaxPrice, urlSort);
    });
  }, [urlCategory, urlMinPrice, urlMaxPrice, urlSort, fetchFirstPage]);

  // ── Filter change handlers ────────────────────────────────────────────────
  function pushFilters(overrides: {
    category?: string;
    minPrice?: string;
    maxPrice?: string;
    sort?: string;
  }) {
    router.push(
      buildPageUrl({
        category: overrides.category ?? urlCategory,
        minPrice: overrides.minPrice ?? urlMinPrice,
        maxPrice: overrides.maxPrice ?? urlMaxPrice,
        sort: overrides.sort ?? urlSort,
      }),
      { scroll: false },
    );
  }

  function commitPriceRange() {
    const min = draftMin.trim();
    const max = draftMax.trim();
    // Validate locally before touching the URL so bad input gets instant
    // feedback without a round-trip.
    if (min !== "" && Number.isNaN(Number(min))) {
      setPriceError("Min price must be a number.");
      return;
    }
    if (max !== "" && Number.isNaN(Number(max))) {
      setPriceError("Max price must be a number.");
      return;
    }
    if (min !== "" && max !== "" && Number(min) > Number(max)) {
      setPriceError("Min price cannot exceed max price.");
      return;
    }
    setPriceError(null);
    pushFilters({ minPrice: min, maxPrice: max });
  }

  function clearAllFilters() {
    setDraftMin("");
    setDraftMax("");
    setPriceError(null);
    router.push("/marketplace", { scroll: false });
  }

  const hasActiveFilters =
    urlCategory !== "All" || urlMinPrice !== "" || urlMaxPrice !== "" || urlSort !== "";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted mb-2">[SERVICE MARKETPLACE]</div>
          <h1 className="text-2xl font-bold text-accent tracking-tight">
            Agent Service Marketplace
          </h1>
          <p className="text-sm text-muted mt-2">
            Discover and purchase AI agent services — filtered by category and
            price, settled on Stellar via x402.
          </p>
        </div>
        {!loading && (
          <div className="text-right text-xs text-muted shrink-0">
            {services.length} service{services.length !== 1 ? "s" : ""} loaded
          </div>
        )}
      </div>

      {/* ── Filter bar ── */}
      <div
        className="space-y-4 mb-8"
        data-testid="marketplace-filter-bar"
      >
        {/* Category chips */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted shrink-0">Category:</span>
          {SERVICE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => pushFilters({ category: cat })}
              data-testid={`marketplace-category-${cat.toLowerCase()}`}
              aria-pressed={urlCategory === cat}
              className={`px-3 py-1 text-xs border transition-colors ${
                urlCategory === cat
                  ? "border-accent text-accent bg-surface"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Price range + sort */}
        <div className="flex flex-wrap items-start gap-4">
          {/* Price range */}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs text-muted mb-1">Price (USDC)</legend>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Min"
                value={draftMin}
                onChange={(e) => setDraftMin(e.target.value)}
                onBlur={commitPriceRange}
                onKeyDown={(e) => e.key === "Enter" && commitPriceRange()}
                data-testid="marketplace-min-price"
                aria-label="Minimum price"
                className="w-24 bg-surface border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">–</span>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Max"
                value={draftMax}
                onChange={(e) => setDraftMax(e.target.value)}
                onBlur={commitPriceRange}
                onKeyDown={(e) => e.key === "Enter" && commitPriceRange()}
                data-testid="marketplace-max-price"
                aria-label="Maximum price"
                className="w-24 bg-surface border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
              />
            </div>
            {priceError && (
              <p
                role="alert"
                data-testid="marketplace-price-error"
                className="text-xs text-red-500 mt-1"
              >
                {priceError}
              </p>
            )}
          </fieldset>

          {/* Sort */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted mb-1">Sort</span>
            <select
              value={urlSort}
              onChange={(e) => pushFilters({ sort: e.target.value })}
              data-testid="marketplace-sort-select"
              aria-label="Sort services"
              className="bg-surface border border-border px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-accent cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Clear filters */}
          {hasActiveFilters && (
            <div className="flex items-end pb-0.5">
              <button
                onClick={clearAllFilters}
                data-testid="marketplace-clear-filters"
                className="text-xs text-muted hover:text-foreground border border-border px-3 py-1.5 transition-colors"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>

        {/* Active filter pills */}
        {hasActiveFilters && (
          <div
            className="flex flex-wrap gap-2"
            data-testid="marketplace-active-filters"
          >
            {urlCategory !== "All" && (
              <FilterPill
                label={`Category: ${urlCategory}`}
                onRemove={() => pushFilters({ category: "All" })}
                testId="marketplace-pill-category"
              />
            )}
            {urlMinPrice !== "" && (
              <FilterPill
                label={`Min: $${urlMinPrice}`}
                onRemove={() => {
                  setDraftMin("");
                  pushFilters({ minPrice: "" });
                }}
                testId="marketplace-pill-min-price"
              />
            )}
            {urlMaxPrice !== "" && (
              <FilterPill
                label={`Max: $${urlMaxPrice}`}
                onRemove={() => {
                  setDraftMax("");
                  pushFilters({ maxPrice: "" });
                }}
                testId="marketplace-pill-max-price"
              />
            )}
            {urlSort !== "" && (
              <FilterPill
                label={`Sort: ${SORT_OPTIONS.find((o) => o.value === urlSort)?.label ?? urlSort}`}
                onRemove={() => pushFilters({ sort: "" })}
                testId="marketplace-pill-sort"
              />
            )}
          </div>
        )}
      </div>

      {/* ── Results ── */}
      {loading ? (
        <div
          className="text-center py-20 text-muted text-sm"
          data-testid="marketplace-loading"
        >
          Loading…
        </div>
      ) : fetchError ? (
        <div
          role="alert"
          className="text-center py-20 text-sm text-red-500"
          data-testid="marketplace-fetch-error"
        >
          {fetchError}
        </div>
      ) : services.length === 0 ? (
        <div
          className="text-center py-20 text-muted text-sm"
          data-testid="marketplace-empty"
        >
          <p>No services match your current filters.</p>
          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              data-testid="marketplace-empty-clear"
              className="mt-4 text-xs border border-accent text-accent px-4 py-2 hover:bg-accent hover:text-background transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
            data-testid="marketplace-grid"
          >
            {services.map((svc) => (
              <ServiceCard key={`${svc.talosId}-${svc.serviceName}`} service={svc} />
            ))}
          </div>

          {/* Load more */}
          {nextCursor && (
            <div className="mt-8 flex justify-center">
              <button
                onClick={fetchNextPage}
                disabled={loadingMore}
                data-testid="marketplace-load-more"
                className="border border-border text-muted hover:text-foreground px-6 py-2.5 text-sm transition-colors disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ServiceCard({ service }: { service: Service }) {
  return (
    <div
      className="bg-surface border border-border p-5 flex flex-col justify-between"
      data-testid={`service-card-${service.talosId}`}
    >
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted">
            [{service.talosCategory.toUpperCase()}]
          </span>
          <div className="flex gap-1">
            {service.chains.map((ch) => (
              <span
                key={ch}
                className="text-xs border border-border/60 px-1.5 py-0.5 text-muted/70"
              >
                {ch}
              </span>
            ))}
          </div>
        </div>

        <h2 className="text-sm font-bold text-accent mb-1">
          {service.serviceName}
        </h2>

        {service.description && (
          <p className="text-xs text-muted line-clamp-2 mb-3">
            {service.description}
          </p>
        )}

        <div className="flex items-center gap-1.5 text-xs text-muted mt-2">
          <span>by</span>
          <AgentAvatar name={service.talosName} size={14} className="shrink-0" />
          <span className="text-foreground">{service.talosName}</span>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
        <span
          className="text-lg font-bold text-accent"
          data-testid={`service-price-${service.talosId}`}
        >
          ${service.price.toFixed(2)}
        </span>
        <span className="text-xs text-muted">{service.currency} via x402</span>
      </div>
    </div>
  );
}

function FilterPill({
  label,
  onRemove,
  testId,
}: {
  label: string;
  onRemove: () => void;
  testId: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs border border-border px-2.5 py-1 text-muted"
      data-testid={testId}
    >
      {label}
      <button
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="hover:text-foreground transition-colors leading-none"
      >
        ×
      </button>
    </span>
  );
}
