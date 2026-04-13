"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/components/wallet-gate";
import { AgentAvatar } from "@/components/agent-avatar";

type PlaybookContent = {
  schedule?: { posts_per_day: number; best_hours_utc: number[]; thread_days: string[] };
  templates?: { type: string; pattern: string; usage: string }[];
  hashtags?: string[];
  tactics?: string[];
} | null;

type Playbook = {
  id: string;
  title: string;
  talos: string;
  talosId: string;
  category: string;
  channel: string;
  description: string;
  price: number;
  purchases: number;
  version: number;
  impressions: number;
  engagementRate: number;
  conversions: number;
  periodDays: number;
  tags: string[];
  content: PlaybookContent;
  createdAt: string;
  status: string;
};

type PurchasedItem = {
  purchaseId: string;
  appliedAt: string | null;
  txHash: string | null;
  purchasedAt: string;
  playbook: {
    id: string;
    title: string;
    talos: string;
    category: string;
    channel: string;
    price: number;
    version: number;
  };
};

const CATEGORIES = [
  "All",
  "Channel Strategy",
  "Content Templates",
  "Targeting",
  "Response",
  "Growth Hacks",
];

const CHANNELS = ["All", "X", "LinkedIn", "Reddit", "Product Hunt"];

export default function PlaybooksPage() {
  const { isConnected, address, connect } = useWallet();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [channel, setChannel] = useState("All");
  const [selected, setSelected] = useState<Playbook | null>(null);
  const [tab, setTab] = useState<"browse" | "my" | "purchased">("browse");

  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [myPlaybooks, setMyPlaybooks] = useState<Playbook[]>([]);
  const [purchased, setPurchased] = useState<PurchasedItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch browse playbooks
  const fetchPlaybooks = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (category !== "All") params.set("category", category);
    if (channel !== "All") params.set("channel", channel);
    if (search) params.set("search", search);
    const res = await fetch(`/api/playbooks?${params}`);
    if (res.ok) {
      const json = await res.json();
      setPlaybooks(json.data ?? []);
    }
    setLoading(false);
  }, [category, channel, search]);

  useEffect(() => {
    if (tab === "browse") fetchPlaybooks();
  }, [tab, fetchPlaybooks]);

  // Fetch my playbooks
  useEffect(() => {
    if (tab === "my" && isConnected && address) {
      setLoading(true);
      fetch(`/api/playbooks/my?wallet=${address}`)
        .then((r) => r.json())
        .then(setMyPlaybooks)
        .finally(() => setLoading(false));
    }
  }, [tab, isConnected, address]);

  // Fetch purchased (also on browse to check unlock status)
  useEffect(() => {
    if (isConnected && address) {
      const shouldLoad = tab === "purchased" || tab === "browse";
      if (shouldLoad) {
        if (tab === "purchased") setLoading(true);
        fetch(`/api/playbooks/purchased?wallet=${address}`)
          .then((r) => r.json())
          .then(setPurchased)
          .finally(() => { if (tab === "purchased") setLoading(false); });
      }
    }
  }, [tab, isConnected, address]);

  const handlePurchase = async (playbookId: string) => {
    if (!address) return;
    const res = await fetch(`/api/playbooks/${playbookId}/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerAddress: address }),
    });
    if (res.ok) {
      setSelected(null);
      fetchPlaybooks();
    }
  };

  const handleApply = async (playbookId: string) => {
    if (!address) return;
    const res = await fetch(`/api/playbooks/${playbookId}/apply`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyerAddress: address }),
    });
    if (res.ok) {
      // Refresh purchased list
      fetch(`/api/playbooks/purchased?wallet=${address}`)
        .then((r) => r.json())
        .then(setPurchased);
    }
  };

  const totalPurchases = playbooks.reduce((s, p) => s + p.purchases, 0);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted mb-2">[PLAYBOOK MARKETPLACE]</div>
          <h1 className="text-2xl font-bold text-accent">
            Agent Knowledge Exchange
          </h1>
          <p className="text-sm text-muted mt-2">
            Battle-tested GTM strategies, packaged by agents, purchased with x402.
          </p>
        </div>
        <div className="text-right text-xs text-muted shrink-0">
          {playbooks.length} playbooks / {totalPurchases} purchases
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 sm:gap-6 border-b border-border mb-8 overflow-x-auto scrollbar-hide">
        {(["browse", "my", "purchased"] as const).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setSelected(null);
            }}
            className={`pb-3 text-sm transition-colors whitespace-nowrap shrink-0 ${
              tab === t
                ? "text-accent border-b border-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t === "browse"
              ? "Browse"
              : t === "my"
              ? "My Playbooks"
              : "Purchased"}
          </button>
        ))}
      </div>

      {tab === "browse" && !selected && (
        <>
          {/* Filters */}
          <div className="space-y-4 mb-8">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search playbooks..."
              className="w-full bg-surface border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Category:</span>
                <div className="flex flex-wrap gap-1">
                  {CATEGORIES.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
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
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Channel:</span>
                <div className="flex gap-1">
                  {CHANNELS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setChannel(c)}
                      className={`px-2.5 py-1 text-xs border transition-colors ${
                        channel === c
                          ? "border-accent text-accent"
                          : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Grid */}
          {loading ? (
            <div className="text-center py-20 text-muted text-sm">
              Loading...
            </div>
          ) : playbooks.length === 0 ? (
            <div className="text-center py-20 text-muted text-sm">
              No playbooks found matching your criteria.
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {playbooks.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className="bg-surface border border-border p-5 text-left hover:bg-surface-hover transition-colors group"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted">
                      [{p.category.toUpperCase()}]
                    </span>
                    <span className="text-xs text-muted">{p.channel}</span>
                  </div>
                  <h3 className="text-sm font-bold text-accent mb-1 group-hover:text-accent transition-colors">
                    {p.title}
                  </h3>
                  <p className="text-xs text-muted mb-4 line-clamp-2">
                    {p.description}
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted inline-flex items-center gap-1.5">
                      by{" "}
                      <AgentAvatar name={p.talos} size={14} className="shrink-0" />
                      <span className="text-foreground">{p.talos}</span>
                    </span>
                    <span className="text-accent font-bold">
                      ${Number(p.price).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-3 text-xs text-muted">
                    <span>{p.purchases} sold</span>
                    <span>v{p.version}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Detail View */}
      {tab === "browse" && selected && (
        <div>
          <button
            onClick={() => setSelected(null)}
            className="text-xs text-muted hover:text-foreground mb-6 transition-colors"
          >
            &larr; Back to browse
          </button>

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Main info */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-surface border border-border p-6">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-xs text-muted border border-border px-2 py-0.5">
                    [{selected.category.toUpperCase()}]
                  </span>
                  <span className="text-xs text-muted border border-border px-2 py-0.5">
                    {selected.channel}
                  </span>
                  <span className="text-xs text-muted">
                    v{selected.version}
                  </span>
                </div>
                <h2 className="text-xl font-bold text-accent mb-2">
                  {selected.title}
                </h2>
                <p className="text-sm text-muted leading-relaxed mb-4">
                  {selected.description}
                </p>
                <div className="flex items-center gap-2 text-xs text-muted">
                  by{" "}
                  <AgentAvatar name={selected.talos} size={16} className="shrink-0" />
                  <span className="text-foreground">{selected.talos}</span>
                </div>
              </div>

              {/* Metrics */}
              <div className="bg-surface border border-border p-6">
                <div className="text-xs text-muted mb-4">
                  [VERIFIED METRICS]
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <MetricCard
                    label="Impressions"
                    value={selected.impressions.toLocaleString()}
                  />
                  <MetricCard
                    label="Engagement Rate"
                    value={`${Number(selected.engagementRate)}%`}
                  />
                  <MetricCard
                    label="Conversions"
                    value={selected.conversions.toString()}
                  />
                  <MetricCard
                    label="Test Period"
                    value={`${selected.periodDays}d`}
                  />
                </div>
                <p className="text-xs text-muted mt-4">
                  Metrics verified against TALOS activity logs by the protocol.
                </p>
              </div>

              {/* Contents preview */}
              <PlaybookContents
                content={selected.content}
                isPurchased={purchased.some((pp) => pp.playbook.id === selected.id)}
              />
            </div>

            {/* Sidebar */}
            <div className="space-y-4">
              <div className="bg-surface border border-border p-6">
                <div className="text-2xl font-bold text-accent mb-1">
                  ${Number(selected.price).toFixed(2)}
                </div>
                <div className="text-xs text-muted mb-6">
                  USDC via x402
                </div>
                {isConnected ? (
                  <button
                    onClick={() => handlePurchase(selected.id)}
                    className="w-full bg-accent text-background py-2.5 text-sm font-medium hover:bg-foreground transition-colors mb-3"
                  >
                    Purchase Playbook
                  </button>
                ) : (
                  <button
                    onClick={connect}
                    className="w-full bg-accent text-background py-2.5 text-sm font-medium hover:bg-foreground transition-colors mb-3 flex items-center justify-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                      <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
                    </svg>
                    Connect to Purchase
                  </button>
                )}
                <p className="text-xs text-muted leading-relaxed">
                  Your agent will auto-apply the strategy, templates, and
                  schedule after purchase.
                </p>
              </div>

              <div className="bg-surface border border-border p-6 text-xs space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted">Purchases</span>
                  <span className="text-foreground">{selected.purchases}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Version</span>
                  <span className="text-foreground">{selected.version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Published</span>
                  <span className="text-foreground">
                    {new Date(selected.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Updates</span>
                  <span className="text-foreground">
                    Auto (latest version)
                  </span>
                </div>
              </div>

              <div className="bg-surface border border-border p-6">
                <div className="text-xs text-muted mb-3">Tags</div>
                <div className="flex flex-wrap gap-1">
                  {selected.tags.map((t) => (
                    <span
                      key={t}
                      className="text-xs border border-border px-2 py-0.5 text-muted"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* My Playbooks tab */}
      {tab === "my" && (
        isConnected ? (
          loading ? (
            <div className="text-center py-20 text-muted text-sm">Loading...</div>
          ) : myPlaybooks.length === 0 ? (
            <div className="border border-dashed border-border p-8 text-center">
              <p className="text-sm text-muted mb-2">
                Playbooks are auto-generated when your agent accumulates enough
                GTM data.
              </p>
              <p className="text-xs text-muted">
                Keep your Prime Agent running to build new playbooks.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {myPlaybooks.map((p) => (
                <div key={p.id} className="bg-surface border border-border p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-sm font-bold text-accent">
                        {p.title}
                      </h3>
                      <p className="text-xs text-muted mt-1 flex items-center gap-1.5">
                        Auto-generated from <AgentAvatar name={p.talos} size={14} className="shrink-0" /> {p.talos} activity
                      </p>
                    </div>
                    <span
                      className={`text-xs font-bold ${
                        p.status === "active"
                          ? "text-accent"
                          : "text-accent/60"
                      }`}
                    >
                      [{p.status.toUpperCase()}]
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-4 text-xs mb-4">
                    <div>
                      <div className="text-muted">Revenue</div>
                      <div className="text-accent font-bold">
                        ${(Number(p.price) * p.purchases).toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted">Sales</div>
                      <div className="text-foreground">{p.purchases}</div>
                    </div>
                    <div>
                      <div className="text-muted">Engagement</div>
                      <div className="text-foreground">
                        {Number(p.engagementRate)}%
                      </div>
                    </div>
                    <div>
                      <div className="text-muted">Version</div>
                      <div className="text-foreground">v{p.version}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <WalletRequiredTab
            message="Connect your wallet to view and manage your published playbooks."
            onConnect={connect}
          />
        )
      )}

      {/* Purchased tab */}
      {tab === "purchased" && (
        isConnected ? (
          loading ? (
            <div className="text-center py-20 text-muted text-sm">Loading...</div>
          ) : purchased.length === 0 ? (
            <div className="text-center py-20 text-muted text-sm">
              No purchased playbooks yet.
            </div>
          ) : (
            <div className="space-y-4">
              {purchased.map((pp) => (
                <div
                  key={pp.purchaseId}
                  className="bg-surface border border-border p-6 flex items-center justify-between"
                >
                  <div>
                    <h3 className="text-sm font-bold text-accent">
                      {pp.playbook.title}
                    </h3>
                    <p className="text-xs text-muted mt-1 flex items-center gap-1.5">
                      by <AgentAvatar name={pp.playbook.talos} size={14} className="shrink-0" /> {pp.playbook.talos} / $
                      {Number(pp.playbook.price).toFixed(2)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs font-bold ${
                        pp.appliedAt
                          ? "text-accent"
                          : "text-accent/60"
                      }`}
                    >
                      [{pp.appliedAt ? "APPLIED" : "NOT APPLIED"}]
                    </span>
                    {!pp.appliedAt && (
                      <button
                        onClick={() => handleApply(pp.playbook.id)}
                        className="px-3 py-1.5 text-xs bg-accent text-background hover:bg-foreground transition-colors"
                      >
                        Apply to Agent
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : (
          <WalletRequiredTab
            message="Connect your wallet to view your purchased playbooks."
            onConnect={connect}
          />
        )
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-lg font-bold text-accent">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function PlaybookContents({ content, isPurchased }: { content: PlaybookContent; isPurchased: boolean }) {
  const c = content as PlaybookContent;

  // Unlocked: purchased AND has content
  if (isPurchased && c) {
    return (
    <div className="bg-surface border border-border p-6 space-y-5">
      <div className="text-xs text-accent font-bold mb-4">[PLAYBOOK CONTENTS — UNLOCKED]</div>
      {c.schedule && (
        <div>
          <div className="text-xs text-muted mb-2">Schedule</div>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <span className="text-muted">Posts/day:</span>{" "}
              <span className="text-foreground">{c.schedule.posts_per_day}</span>
            </div>
            <div>
              <span className="text-muted">Best hours (UTC):</span>{" "}
              <span className="text-foreground">{c.schedule.best_hours_utc.join(", ")}</span>
            </div>
            <div>
              <span className="text-muted">Thread days:</span>{" "}
              <span className="text-foreground">{c.schedule.thread_days.join(", ")}</span>
            </div>
          </div>
        </div>
      )}
      {c.templates && c.templates.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2">Templates ({c.templates.length})</div>
          <div className="space-y-2">
            {c.templates.map((t, i) => (
              <div key={i} className="bg-background border border-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-accent">[{t.type.toUpperCase()}]</span>
                  <span className="text-xs text-muted">{t.usage}</span>
                </div>
                <p className="text-xs text-foreground font-mono">{t.pattern}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {c.hashtags && c.hashtags.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2">Hashtags</div>
          <div className="flex flex-wrap gap-1">
            {c.hashtags.map((h) => (
              <span key={h} className="text-xs border border-border px-2 py-0.5 text-accent">{h}</span>
            ))}
          </div>
        </div>
      )}
      {c.tactics && c.tactics.length > 0 && (
        <div>
          <div className="text-xs text-muted mb-2">Tactics ({c.tactics.length})</div>
          <ul className="space-y-1">
            {c.tactics.map((t, i) => (
              <li key={i} className="text-xs text-foreground flex gap-2">
                <span className="text-muted shrink-0">{i + 1}.</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
  }

  // Locked view (not purchased or no content)
  const items = [
    { label: "Posting Schedule", count: c?.schedule ? 1 : 0 },
    { label: "Content Templates", count: c?.templates?.length ?? 0 },
    { label: "Hashtags", count: c?.hashtags?.length ?? 0 },
    { label: "Tactics", count: c?.tactics?.length ?? 0 },
  ];
  return (
    <div className="bg-surface border border-border p-6">
      <div className="text-xs text-muted mb-4">[PLAYBOOK CONTENTS]</div>
      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center justify-between py-2 border-b border-border">
            <span className="text-sm text-foreground">
              {item.label}{item.count > 0 ? ` (${item.count})` : ""}
            </span>
            <span className="text-xs text-muted">[LOCKED]</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted mt-4">Purchase to unlock full playbook contents.</p>
    </div>
  );
}

function WalletRequiredTab({ message, onConnect }: { message: string; onConnect: () => void }) {
  return (
    <div className="bg-surface border border-border p-12 text-center">
      <div className="text-xs text-muted mb-4 tracking-wider">[WALLET REQUIRED]</div>
      <p className="text-sm text-muted mb-6">{message}</p>
      <button
        onClick={onConnect}
        className="bg-accent text-background px-6 py-2.5 text-sm font-medium hover:bg-foreground transition-colors inline-flex items-center gap-2"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
        </svg>
        Connect Wallet
      </button>
    </div>
  );
}
