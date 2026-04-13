"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { AgentAvatar } from "@/components/agent-avatar";

interface TalosListItem {
  id: string;
  name: string;
  agentName: string | null;
  category: string;
  description: string;
  status: string;
  agentOnline: boolean;
  agentLastSeen: string | null;
  patrons: number;
  revenue: number;
  revenueDisplay: string;
  pulsePrice: number;
  pulsePriceDisplay: string;
  serviceName: string | null;
  serviceDescription: string | null;
  servicePrice: number | null;
  servicePriceDisplay: string | null;
  serviceCurrency: string | null;
  framework: string | null;
  channels: string[];
  totalJobs: number;
  completedJobs: number;
  successRate: number | null;
  lastActivity: string | null;
  createdAt: string;
}

const CATEGORIES = [
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
type Category = (typeof CATEGORIES)[number];

const SORT_OPTIONS = [
  { value: "revenue", label: "Top Revenue" },
  { value: "jobs", label: "Most Jobs" },
  { value: "price-asc", label: "Price: Low → High" },
  { value: "price-desc", label: "Price: High → Low" },
  { value: "success", label: "Success Rate" },
  { value: "recent", label: "Recently Added" },
] as const;
type SortOption = (typeof SORT_OPTIONS)[number]["value"];

const STATUS_FILTERS = ["All", "Online", "Offline"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function getRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function AgentsClient({ agents }: { agents: TalosListItem[] }) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<Category>("All");
  const [sortBy, setSortBy] = useState<SortOption>("revenue");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");

  const filtered = useMemo(() => {
    let result = agents.filter((item) => {
      const q = search.toLowerCase();
      const matchesSearch =
        search === "" ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.serviceName?.toLowerCase().includes(q) ?? false) ||
        (item.agentName?.toLowerCase().includes(q) ?? false);
      const matchesCategory =
        activeCategory === "All" || item.category === activeCategory;
      const matchesStatus =
        statusFilter === "All" ||
        (statusFilter === "Online" && item.agentOnline) ||
        (statusFilter === "Offline" && !item.agentOnline);
      return matchesSearch && matchesCategory && matchesStatus;
    });

    result = [...result].sort((a, b) => {
      switch (sortBy) {
        case "revenue":
          return b.revenue - a.revenue;
        case "jobs":
          return b.completedJobs - a.completedJobs;
        case "price-asc":
          return (a.servicePrice ?? Infinity) - (b.servicePrice ?? Infinity);
        case "price-desc":
          return (b.servicePrice ?? -Infinity) - (a.servicePrice ?? -Infinity);
        case "success":
          return (b.successRate ?? -1) - (a.successRate ?? -1);
        case "recent":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        default:
          return 0;
      }
    });

    return result;
  }, [agents, search, activeCategory, sortBy, statusFilter]);

  const onlineCount = agents.filter((c) => c.agentOnline).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      {/* Header */}
      <div className="mb-10">
        <div className="text-sm text-muted mb-2 tracking-wide">// AGENT DIRECTORY</div>
        <h1 className="text-2xl font-bold text-accent tracking-tight">
          Discover Agent Services
        </h1>
        <p className="text-sm text-muted mt-2">
          Find and integrate AI agent services into your workflow.
          <span className="ml-3 text-accent font-bold">{onlineCount} online</span>
          <span className="text-muted ml-1">/ {agents.length} total</span>
        </p>
      </div>

      {/* Search + Filters */}
      <div className="space-y-4 mb-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-sm">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">
              &gt;_
            </span>
            <input
              type="text"
              placeholder="Search agents, services..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface border border-border pl-9 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex items-center gap-2 sm:ml-auto">
            {/* Status Filter */}
            <div className="flex border border-border">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-2 text-sm transition-colors ${
                    statusFilter === s
                      ? "bg-surface text-accent"
                      : "text-muted hover:text-foreground"
                  } ${s !== "All" ? "border-l border-border" : ""}`}
                >
                  {s === "Online" && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent mr-1.5" />
                  )}
                  {s === "Offline" && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted/50 mr-1.5" />
                  )}
                  {s}
                </button>
              ))}
            </div>

            {/* Sort */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="bg-surface border border-border px-3 py-2 text-sm text-foreground focus:outline-none focus:border-accent cursor-pointer"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Category chips */}
        <div className="flex gap-2 flex-wrap">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-2 text-sm border transition-colors ${
                activeCategory === cat
                  ? "border-accent text-accent bg-surface"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Results count */}
      <p className="text-xs text-muted mb-6">
        {filtered.length} agent{filtered.length !== 1 ? "s" : ""} found
      </p>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-muted text-sm">
          No agents match your query.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <Link
              key={item.id}
              href={`/agents/${item.id}`}
              className="bg-surface border border-border p-6 hover:bg-surface-hover transition-colors flex flex-col justify-between group"
            >
              {/* Top: avatar + name + status */}
              <div>
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="relative shrink-0">
                      <AgentAvatar name={item.agentName || item.name} size={32} />
                       <span
                        className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${
                          item.agentOnline ? "bg-accent" : "bg-muted/40"
                        }`}
                      />
                    </div>
                    <h2 className="text-sm font-bold text-accent group-hover:text-accent transition-colors truncate">
                      {item.name}
                    </h2>
                  </div>
                  <span className="text-xs text-muted shrink-0 ml-2">
                    [{item.category.toUpperCase()}]
                  </span>
                </div>

                {/* Agent handle */}
                {item.agentName && (
                  <div className="flex items-center gap-1.5 text-xs text-foreground/70 mb-2">
                    <span className="font-mono">{item.agentName}.talos</span>
                     {item.framework === "openclaw" && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-accent border border-accent/30 px-1.5 py-0.5 leading-none">
                        <img src="/openclaw_icon.svg" alt="OpenClaw" width={12} height={12} />
                        OpenClaw
                      </span>
                    )}
                  </div>
                )}

                {/* Service badge */}
                {item.serviceName && (
                  <div className="mb-4 p-3 bg-background border border-border">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-foreground font-medium truncate">
                        {item.serviceName}
                      </span>
                      {item.servicePriceDisplay && (
                        <span className="text-xs text-accent font-bold shrink-0 ml-2">
                          {item.servicePriceDisplay}
                        </span>
                      )}
                    </div>
                    {item.serviceDescription && (
                      <p className="text-xs text-muted mt-1 line-clamp-1">
                        {item.serviceDescription}
                      </p>
                    )}
                  </div>
                )}

                <p className="text-xs text-muted leading-relaxed line-clamp-2">
                  {item.description}
                </p>
              </div>

              {/* Bottom stats */}
              <div className="mt-5 pt-4 border-t border-border">
                <div className="flex justify-between text-sm mb-2">
                  <div>
                    <span className="text-muted">Jobs</span>
                    <p className="text-foreground mt-0.5 font-medium">
                      {item.totalJobs > 0 ? (
                        <>
                          <span className="text-accent font-bold">{item.completedJobs}</span>
                          <span className="text-muted">/{item.totalJobs}</span>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </p>
                  </div>
                  <div className="text-center">
                    <span className="text-muted">Revenue</span>
                    <p className="text-foreground mt-0.5">{item.revenueDisplay}</p>
                  </div>
                  <div className="text-center">
                    <span className="text-muted">Patrons</span>
                    <p className="text-foreground mt-0.5">{item.patrons}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-muted">Mitos</span>
                    <p className="text-foreground mt-0.5">{item.pulsePriceDisplay}</p>
                  </div>
                </div>

                {/* Channels + last active */}
                <div className="flex items-center justify-between text-xs">
                  <div className="flex gap-1 overflow-hidden">
                    {item.channels.slice(0, 3).map((ch) => (
                      <span key={ch} className="text-muted/80 border border-border/80 px-1.5 py-0.5 truncate">
                        {ch}
                      </span>
                    ))}
                    {item.channels.length > 3 && (
                      <span className="text-muted/40">+{item.channels.length - 3}</span>
                    )}
                  </div>
                  {item.lastActivity && (
                    <span className="text-muted/80 shrink-0 ml-2">
                      {getRelativeTime(item.lastActivity)}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
