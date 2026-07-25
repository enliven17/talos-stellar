import { BenchmarkOptions } from "../runner";
import { loadConfig } from "../config";
import { NextRequest } from "next/server";

const config = loadConfig({ runs: 50, warmupRuns: 5 });

import { GET as liveGET } from "@/app/api/health/live/route";
import { generateTalosIds, generateActivityEntries, generateTransferPayloads } from "../datasets";
import { computePercentiles, summarizeStats } from "../metrics";

function mockRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

export function healthLivenessSuite(): BenchmarkOptions[] {
  return [
    {
      label: "health-liveness",
      fn: () => { liveGET(); },
      config,
    },
    {
      label: "health-liveness-json",
      fn: async () => {
        const res = liveGET();
        await res.json();
      },
      config,
    },
  ];
}

export function talosListSerializationSuite(): BenchmarkOptions[] {
  const ids = generateTalosIds(1000);
  const entries = ids.map((id, i) => ({
    id,
    onChainId: i,
    agentName: `agent-${i}`,
    name: `Talos ${i}`,
    category: ["Marketing", "Development", "Research", "Design", "Finance"][i % 5],
    description: `Benchmark description for talos entry ${i}`,
    status: "Active",
    stellarAssetCode: null,
    pulsePrice: "0.001000",
    totalSupply: 1000000,
    creatorShare: 60,
    investorShare: 25,
    treasuryShare: 15,
    persona: null,
    targetAudience: null,
    channels: ["twitter", "discord"],
    toneVoice: null,
    approvalThreshold: "10.00",
    gtmBudget: "200.00",
    minPatronPulse: null,
    agentOnline: false,
    agentLastSeen: null,
    walletPublicKey: null,
    creatorPublicKey: null,
    investorPublicKey: null,
    treasuryPublicKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    patrons: Math.floor(Math.random() * 100),
  }));

  return [
    {
      label: "talos-list-serialize-1000",
      fn: () => {
        const hasMore = entries.length > 50;
        const page = hasMore ? entries.slice(0, 50) : entries;
        const lastItem = page[page.length - 1];
        const nextCursor = hasMore && lastItem
          ? `${lastItem.createdAt.toISOString()}|${lastItem.id}`
          : null;
        JSON.stringify({ data: page.map((e) => ({ ...e, patrons: e.patrons ?? 0 })), nextCursor });
      },
      config,
    },
    {
      label: "talos-list-response-json",
      fn: () => {
        const result = { data: entries.slice(0, 50), nextCursor: null };
        const body = JSON.stringify(result);
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      config,
    },
  ];
}

export function activityProcessingSuite(): BenchmarkOptions[] {
  const activities = generateActivityEntries(500);

  return [
    {
      label: "activity-validate-500",
      fn: () => {
        const validTypes = ["post", "research", "reply", "engagement", "commerce", "approval"];
        const validChannels = ["twitter", "discord", "telegram", "email", "web"];
        for (const a of activities) {
          if (!validTypes.includes(a.type)) throw new Error("invalid type");
          if (!validChannels.includes(a.channel)) throw new Error("invalid channel");
        }
      },
      config,
    },
    {
      label: "activity-batch-response",
      fn: () => {
        const body = JSON.stringify({ data: activities.slice(0, 100), nextCursor: null });
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      config,
    },
  ];
}

export function transferValidationSuite(): BenchmarkOptions[] {
  const transfers = generateTransferPayloads(200);

  return [
    {
      label: "transfer-validate-200",
      fn: () => {
        for (const t of transfers) {
          if (!/^G[A-Z2-7]{55}$/.test(t.destination)) throw new Error("bad dest");
          if (!/^[0-9a-f]{64}$/.test(t.nonce)) throw new Error("bad nonce");
          if (t.asset !== "USDC") throw new Error("bad asset");
        }
      },
      config,
    },
    {
      label: "transfer-json-serialization",
      fn: () => {
        JSON.stringify(transfers);
      },
      config,
    },
  ];
}

export function percentileComputationSuite(): BenchmarkOptions[] {
  const values = Array.from({ length: 10000 }, () => Math.random() * 1000);

  return [
    {
      label: "percentile-10000-values",
      fn: () => {
        computePercentiles(values, [50, 75, 90, 95, 99]);
      },
      config,
    },
    {
      label: "summarize-stats-10000",
      fn: () => {
        summarizeStats(values);
      },
      config,
    },
  ];
}

export function apiRouteSuites(): BenchmarkOptions[] {
  return [
    ...healthLivenessSuite(),
    ...talosListSerializationSuite(),
    ...activityProcessingSuite(),
    ...transferValidationSuite(),
    ...percentileComputationSuite(),
  ];
}