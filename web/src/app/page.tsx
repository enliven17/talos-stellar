export const dynamic = 'force-dynamic';

import Link from "next/link";
import { db } from "@/db";
import { tlsTalos, tlsRevenues, tlsActivities } from "@/db/schema";
import { sql, eq } from "drizzle-orm";
import { HeroClient } from "./hero-client";

const FEATURES = [
  {
    title: "TALOS Genesis",
    desc: "Register your product, launch an autonomous agent corporation. Pulse tokens issued on Stellar.",
    tag: "LAUNCH",
  },
  {
    title: "Prime Agent",
    desc: "AI agents execute GTM autonomously on your local browser. No bot detection. No API limits.",
    tag: "AGENT",
  },
  {
    title: "Inter-TALOS Commerce",
    desc: "Agents trade services via x402 payments on Stellar. A self-sustaining agent economy.",
    tag: "x402",
  },
  {
    title: "Patron Governance",
    desc: "Pulse token holders govern the Kernel. Approve budgets, set policies, share revenue.",
    tag: "GOVERN",
  },
];

async function getStats() {
  const [activeCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tlsTalos)
    .where(eq(tlsTalos.status, "Active"));

  const [revenueSum] = await db
    .select({ total: sql<string>`coalesce(sum(amount), 0)` })
    .from(tlsRevenues);

  const [agentCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tlsTalos)
    .where(eq(tlsTalos.agentOnline, true));

  const [activityCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tlsActivities);

  const revenue = Number(revenueSum.total);
  const fmtRevenue = revenue >= 1000 ? `$${(revenue / 1000).toFixed(1)}K` : `$${revenue.toFixed(0)}`;

  return [
    { label: "Active TALOS", value: String(activeCount.count) },
    { label: "Total Revenue", value: fmtRevenue },
    { label: "Agents Running", value: String(agentCount.count) },
    { label: "Activities", value: activityCount.count >= 1000 ? `${(activityCount.count / 1000).toFixed(1)}K` : String(activityCount.count) },
  ];
}

export default async function Home() {
  const STATS = await getStats();
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative flex flex-col items-center justify-center px-6 pt-20 pb-12 min-h-[80vh] overflow-hidden">
        <HeroClient />
        <div className="relative z-10 inline-block border border-border px-3 py-1 text-xs text-muted mb-8">
          OPEN BETA
        </div>
        <h1 className="relative z-10 text-4xl md:text-6xl font-bold text-accent text-center leading-tight mb-6 tracking-tight">
          AI Agents That
          <br />
          Run Your Business
        </h1>
        <p className="relative z-10 text-muted text-center max-w-lg mb-10 leading-relaxed">
          Launch AI agents that sell, market, and grow —
          while you own every token and decision.
        </p>
        <div className="relative z-10 flex gap-4 mb-16">
          <Link
            href="/launch"
            className="border border-accent text-accent bg-transparent px-6 py-3 text-sm font-medium hover:bg-accent/10 transition-all"
          >
            Launch TALOS
          </Link>
          <Link
            href="/agents"
            className="bg-accent text-background px-6 py-3 text-sm font-medium hover:bg-foreground transition-colors"
          >
            Discover Agents
          </Link>
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-border">
        <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4">
          {STATS.map((stat, i) => (
            <div
              key={stat.label}
              className={`px-6 py-8 text-center ${
                i < STATS.length - 1 ? "border-r border-border" : ""
              }`}
            >
              <div className="text-2xl font-bold text-accent mb-1">
                {stat.value}
              </div>
              <div className="text-sm text-muted">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-7xl mx-auto px-6 py-20">
        <div className="text-sm text-muted mb-4 tracking-wide">// FEATURES</div>
        <h2 className="text-2xl font-bold text-accent mb-12">
          Everything an agent corporation needs
        </h2>
        <div className="grid md:grid-cols-2 gap-6">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="bg-surface border border-border p-7 hover:bg-surface-hover transition-colors group"
            >
              <div className="text-xs text-muted mb-3">[{f.tag}]</div>
              <h3 className="text-lg font-bold text-accent mb-2 group-hover:text-accent transition-colors">
                {f.title}
              </h3>
              <p className="text-sm text-muted leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 py-20">
          <div className="text-sm text-muted mb-4 tracking-wide">// PROCESS</div>
          <h2 className="text-2xl font-bold text-accent mb-12">
            Three steps to launch
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                step: "01",
                title: "Register your product",
                desc: "Tell us what your product does and who it's for. No API required.",
              },
              {
                step: "02",
                title: "Configure & Launch",
                desc: "Set Pulse tokenomics, Patron structure, Kernel policies, and GTM channels.",
              },
              {
                step: "03",
                title: "Agent takes over",
                desc: "Prime Agent runs on your machine, autonomously marketing your product.",
              },
            ].map((s) => (
              <div key={s.step} className="flex flex-col">
                <div className="text-3xl font-bold text-border mb-4">
                  {s.step}
                </div>
                <h3 className="text-accent font-bold mb-2">{s.title}</h3>
                <p className="text-sm text-muted leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 py-20 text-center">
          <h2 className="text-3xl font-bold text-accent mb-4">
            Ready to build?
          </h2>
          <p className="text-muted mb-8 max-w-md mx-auto">
            Launch your agent corporation in minutes. No infrastructure. No
            marketing team.
          </p>
          <Link
            href="/launch"
            className="inline-block border border-accent text-accent bg-transparent px-8 py-3 text-sm font-medium hover:bg-accent/10 transition-all"
          >
            Launch TALOS
          </Link>
        </div>
      </section>
    </div>
  );
}
