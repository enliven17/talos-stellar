"use client";

import Link from "next/link";
import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@/components/wallet-gate";
import { AgentAvatar } from "@/components/agent-avatar";
import { AgentAvailabilityBadge } from "@/components/agent-availability-badge";
import { AgentEmptyState } from "@/components/agent-view-states";
import { ScopedApiKeysPanel } from "@/components/scoped-api-keys-panel";
import { AgentPurchasesSection } from "@/components/agent-purchases-section";
import { CopyButton } from "@/components/copy-button";
import { OPERATOR_PUBLIC_KEY, USDC_ISSUER as STELLAR_USDC_ISSUER } from "@/lib/stellar-config";
import {
  TabActivity,
  TabPatrons,
  TabRevenue,
  TabGovernance,
  TabAgent,
  type Approval,
  type DistPreview,
  type BuybackPreview,
} from "./components";


interface ServiceInfo {
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stellarPublicKey: string;
  chains: string[];
}

interface JobStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  successRate: number | null;
  totalRevenue: number;
  jobsToday: number;
}

interface RecentJob {
  id: string;
  serviceName: string;
  status: string;
  amount: number;
  createdAt: string;
}

interface TalosDetail {
  id: string;
  name: string;
  agentName: string | null;
  category: string;
  description: string;
  status: string;
  stellarAssetCode: string;
  tokenSymbol: string;
  pulsePrice: string;
  totalSupply: number;
  creatorPublicKey: string | null;
  walletPublicKey: string | null;
  agentWalletAddress: string | null;
  persona: string;
  targetAudience: string;
  channels: string[];
  approvalThreshold: number;
  gtmBudget: number;
  minPatronPulse: number | null;
  investorShare: number;
  agentOnline: boolean;
  agentLastSeen: string | null;
  createdAt: string;
  revenue: string;
  patronCount: number;
  patrons: { stellarPublicKey: string; role: string; pulseAmount: number; share: number; status: string }[];
  activities: { id: string; type: string; content: string; channel: string; status: string; timestamp: string }[];
  revenueHistory: { month: string; amount: number }[];
  agentStats: { postsToday: number; repliesToday: number; researchesToday: number };
  service: ServiceInfo | null;
  jobStats: JobStats;
  recentJobs: RecentJob[];
}

const TABS = ["Overview", "Services", "Activity", "Patrons", "Revenue", "Purchases", "Governance", "Agent"] as const;
type Tab = (typeof TABS)[number];

const TYPE_ICONS: Record<string, string> = {
  post: ">_",
  research: "??",
  reply: "<>",
  commerce: "$$",
  approval: "!!",
};

const JOB_STATUS_STYLES: Record<string, string> = {
  completed: "text-accent font-bold",
  pending: "text-muted",
  failed: "text-red-600",
};

export function TalosDetailClient({ talos }: { talos: TalosDetail }) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [patronStatus, setPatronStatus] = useState<"none" | "loading" | "patron">("none");
  const { isConnected, connect, address, signTransaction, signMessage } = useWallet();
  const isAgentOwner = Boolean(
    address && (address === talos.creatorPublicKey || address === talos.walletPublicKey)
  );

  const minRequired =
    talos.minPatronPulse ?? Math.floor(talos.totalSupply * 0.001);

  const isPatron =
    talos.patrons.some(
      (p) => p.stellarPublicKey === address && p.status === "active",
    ) || patronStatus === "patron";

  const [myPulseBalance, setPulseBalance] = useState(0);
  useEffect(() => {
    if (!address) return;
    const dbAmount =
      talos.patrons.find((p) => p.stellarPublicKey === address)?.pulseAmount ??
      0;
    setPulseBalance(dbAmount);
  }, [address, talos.patrons]);

  const meetsThreshold = myPulseBalance >= minRequired;

  const handleBecomePatron = useCallback(async () => {
    if (!address || isPatron) return;
    setPatronStatus("loading");
    try {
      const res = await fetch(`/api/talos/${talos.id}/patrons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stellarPublicKey: address,
          pulseAmount: myPulseBalance,
        }),
      });
      if (res.ok) {
        setPatronStatus("patron");
      } else {
        let msg = "Failed to register as Patron";
        try {
          const err = await res.json();
          msg = err.error || msg;
        } catch { /* non-JSON */ }
        alert(msg);
        setPatronStatus("none");
      }
    } catch {
      alert("Network error. Please try again.");
      setPatronStatus("none");
    }
  }, [address, talos.id, isPatron, myPulseBalance]);

  // ─── Buy Token modal ──────────────────────────────────────────────────────
  const [buyOpen, setBuyOpen] = useState(false);
  const [buyAmount, setBuyAmount] = useState("");
  const [buyStatus, setBuyStatus] = useState<"idle" | "buying" | "success" | "error">("idle");
  const [buyResult, setBuyResult] = useState<{ txHash: string; message: string } | null>(null);
  const buyInputRef = useRef<HTMLInputElement>(null);

  const priceNum = parseFloat(talos.pulsePrice.replace("$", "")) || 0;
  const buyQty = Math.max(0, parseInt(buyAmount, 10) || 0);
  const buyCost = Math.round(buyQty * priceNum * 100) / 100;

  const handleBuyToken = useCallback(async () => {
    if (!address || buyQty <= 0) return;
    setBuyStatus("buying");
    try {
      const { Asset, TransactionBuilder, Operation, BASE_FEE, Horizon } =
        await import("@stellar/stellar-sdk");

      const HORIZON_URL = "https://horizon-testnet.stellar.org";
      const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
      const USDC_ISSUER = STELLAR_USDC_ISSUER;
      const recipient = talos.agentWalletAddress ?? OPERATOR_PUBLIC_KEY;

      const server = new Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(address);
      const usdc = new Asset("USDC", USDC_ISSUER);

      const txBuilder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      const assetCode = talos.stellarAssetCode;
      if (assetCode && assetCode.includes(":")) {
        const [mitosCode, mitosIssuer] = assetCode.split(":");
        const mitosAsset = new Asset(mitosCode, mitosIssuer);
        const hasTrustline = (
          account.balances as Array<{
            asset_type: string;
            asset_code?: string;
            asset_issuer?: string;
          }>
        ).some(
          (b) =>
            b.asset_type !== "native" &&
            b.asset_code === mitosCode &&
            b.asset_issuer === mitosIssuer,
        );
        if (!hasTrustline) {
          txBuilder.addOperation(Operation.changeTrust({ asset: mitosAsset }));
        }
      }

      txBuilder.addOperation(
        Operation.payment({
          destination: recipient,
          asset: usdc,
          amount: buyCost.toFixed(7),
        }),
      );

      const tx = txBuilder.setTimeout(60).build();
      const signedXdr = await signTransaction(tx.toXDR());

      const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
      const signedTx = TB.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      const result = await server.submitTransaction(signedTx);
      const txHash = result.hash;

      const res = await fetch(`/api/talos/${talos.id}/buy-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerPublicKey: address,
          amount: buyQty,
          txHash,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setBuyResult({ txHash, message: data.message });
        setBuyStatus("success");
      } else {
        alert(data.error || "Purchase failed");
        setBuyStatus("error");
      }
    } catch (err: unknown) {
      console.error("[buy-token]", err);
      alert(err instanceof Error ? err.message : "Transaction failed");
      setBuyStatus("error");
    }
  }, [address, buyQty, buyCost, talos.id, talos.agentWalletAddress, talos.stellarAssetCode, signTransaction]);

  const closeBuyModal = useCallback(() => {
    setBuyOpen(false);
    setBuyAmount("");
    setBuyStatus("idle");
    setBuyResult(null);
  }, []);

  const openBuyModal = useCallback(() => {
    setBuyOpen(true);
    setTimeout(() => buyInputRef.current?.focus(), 100);
  }, []);

  // ─── Service Request modal ────────────────────────────────────────────────
  const [serviceOpen, setServiceOpen] = useState(false);
  const [servicePayload, setServicePayload] = useState("");
  const [serviceStatus, setServiceStatus] = useState<"idle" | "paying" | "success" | "error">("idle");
  const [serviceResult, setServiceResult] = useState<{ jobId: string; txHash: string; result?: Record<string, unknown>; status?: string } | null>(null);
  const [serviceError, setServiceError] = useState<{ message: string; retryable: boolean; retryAfterMs?: number } | null>(null);
  const [retryCountdown, setRetryCountdown] = useState(0);
  // Hold the interval ID so we can clear it on unmount (prevents memory leaks
  // and stale state updates after the modal is closed / component unmounts).
  const retryIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (retryIntervalRef.current !== null) {
        clearInterval(retryIntervalRef.current);
      }
    };
  }, []);

  const handleRequestService = useCallback(async () => {
    if (!address || !talos.service) return;
    setServiceStatus("paying");
    setServiceError(null);
    try {
      const { Asset, TransactionBuilder, Operation, BASE_FEE, Horizon, Networks } =
        await import("@stellar/stellar-sdk");
      const HORIZON_URL = "https://horizon-testnet.stellar.org";
      const NETWORK_PASSPHRASE = Networks.TESTNET;
      const USDC_ISSUER = STELLAR_USDC_ISSUER;
      const OPERATOR = OPERATOR_PUBLIC_KEY;
      const recipient =
        talos.service.stellarPublicKey ||
        talos.agentWalletAddress ||
        OPERATOR;

      const server = new Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(address);
      const usdc = new Asset("USDC", USDC_ISSUER);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: recipient,
            asset: usdc,
            amount: String(talos.service.price),
          }),
        )
        .setTimeout(60)
        .build();

      const signedXdr = await signTransaction(tx.toXDR());

      let payload: Record<string, unknown> = {};
      try {
        payload = servicePayload.trim() ? JSON.parse(servicePayload) : {};
      } catch {
        payload = { request: servicePayload };
      }

      const res = await fetch(`/api/talos/${talos.id}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerPublicKey: address,
          signedXdr,
          payload,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setServiceResult({
          jobId: data.jobId,
          txHash: data.txHash,
          result: data.result,
          status: data.status,
        });
        setServiceStatus("success");
      } else {
        const isRetryable = Boolean(data.retryable);
        const retryAfterMs = typeof data.retryAfterMs === "number" ? data.retryAfterMs : 0;
        setServiceError({
          message: data.error || "Job creation failed",
          retryable: isRetryable,
          retryAfterMs,
        });
        setServiceStatus("error");
        // Start countdown if server tells us to wait before retrying
        if (isRetryable && retryAfterMs > 0) {
          const seconds = Math.ceil(retryAfterMs / 1000);
          setRetryCountdown(seconds);
          // Clear any previous interval before starting a new one
          if (retryIntervalRef.current !== null) {
            clearInterval(retryIntervalRef.current);
          }
          retryIntervalRef.current = setInterval(() => {
            setRetryCountdown((c) => {
              if (c <= 1) {
                clearInterval(retryIntervalRef.current!);
                retryIntervalRef.current = null;
                return 0;
              }
              return c - 1;
            });
          }, 1000);
        }
      }
    } catch (err: unknown) {
      console.error("[request-service]", err);
      setServiceError({ message: err instanceof Error ? err.message : "Transaction failed", retryable: false });
      setServiceStatus("error");
    }
  }, [address, talos.id, talos.service, talos.agentWalletAddress, servicePayload, signTransaction]);

  // ─── Governance (approvals) ───────────────────────────────────────────────
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeForm, setProposeForm] = useState({
    type: "strategy",
    title: "",
    description: "",
    amount: "",
  });
  const [proposeLoading, setProposeLoading] = useState(false);

  const loadApprovals = useCallback(async () => {
    const res = await fetch(`/api/talos/${talos.id}/approvals`);
    if (res.ok) {
      setApprovals(await res.json());
      setApprovalsLoaded(true);
    }
  }, [talos.id]);

  const handleVote = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      if (!address) return;
      const res = await fetch(
        `/api/talos/${talos.id}/approvals/${approvalId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: decision, decidedBy: address }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        setApprovals((prev) =>
          prev.map((a) =>
            a.id === approvalId
              ? { ...a, status: decision, decidedBy: address }
              : a,
          ),
        );
      } else {
        alert(data.error || "Vote failed");
      }
    },
    [address, talos.id],
  );

  const handlePropose = useCallback(async () => {
    if (!address || !proposeForm.title) return;
    setProposeLoading(true);
    try {
      const res = await fetch(`/api/talos/${talos.id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...proposeForm,
          amount: proposeForm.amount ? Number(proposeForm.amount) : undefined,
          proposerPublicKey: address,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setApprovals((prev) => [data, ...prev]);
        setProposeOpen(false);
        setProposeForm({ type: "strategy", title: "", description: "", amount: "" });
      } else {
        alert(data.error || "Proposal failed");
      }
    } finally {
      setProposeLoading(false);
    }
  }, [address, talos.id, proposeForm]);

  // ─── Revenue distribution ─────────────────────────────────────────────────
  const [distLoading, setDistLoading] = useState(false);
  const [distPreview, setDistPreview] = useState<DistPreview | null>(null);

  const loadDistPreview = useCallback(async () => {
    const res = await fetch(`/api/talos/${talos.id}/revenue/distribute`);
    if (res.ok) setDistPreview(await res.json());
  }, [talos.id]);

  const handleDistribute = useCallback(async () => {
    if (!address) return;
    setDistLoading(true);
    try {
      const res = await fetch(`/api/talos/${talos.id}/revenue/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requesterPublicKey: address }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Distributed! ${data.message}`);
        loadDistPreview();
      } else {
        alert(data.error || "Distribution failed");
      }
    } finally {
      setDistLoading(false);
    }
  }, [address, talos.id, loadDistPreview]);

  // ─── Buyback ──────────────────────────────────────────────────────────────
  const [buybackPreview, setBuybackPreview] = useState<BuybackPreview | null>(null);
  const [buybackLoading, setBuybackLoading] = useState(false);
  const [buybackForm, setBuybackForm] = useState({
    usdcAmount: "",
    mitosAmount: "",
  });

  const loadBuybackPreview = useCallback(async () => {
    const res = await fetch(`/api/talos/${talos.id}/revenue/buyback`);
    if (res.ok) setBuybackPreview(await res.json());
  }, [talos.id]);

  const handleBuyback = useCallback(async () => {
    if (!address) return;
    setBuybackLoading(true);
    try {
      const res = await fetch(`/api/talos/${talos.id}/revenue/buyback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requesterPublicKey: address,
          usdcAmount: Number(buybackForm.usdcAmount),
          mitosAmount: Number(buybackForm.mitosAmount),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message);
        loadBuybackPreview();
      } else {
        alert(data.error || "Buyback failed");
      }
    } finally {
      setBuybackLoading(false);
    }
  }, [address, talos.id, buybackForm, loadBuybackPreview]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12">
      <Link
        href="/agents"
        className="text-xs text-muted hover:text-foreground transition-colors"
      >
        &larr; Agent Directory
      </Link>

      {/* Header */}
      <div className="mt-6 mb-8 flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div className="flex gap-4">
          <div className="shrink-0 mt-1">
            <AgentAvatar name={talos.agentName || talos.name} size={56} />
          </div>
          <div>
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-bold text-accent">{talos.name}</h1>
              <AgentAvailabilityBadge
                agentOnline={talos.agentOnline}
                agentLastSeen={talos.agentLastSeen}
                status={talos.status}
                size="md"
              />
            </div>
            {talos.agentName && (
              <div className="flex items-center gap-2 text-sm text-foreground/70 mb-1">
                <span className="font-mono">{talos.agentName}.talos</span>
                {talos.description.includes("OpenClaw") && (
                  <span className="inline-flex items-center gap-1 text-xs text-red-400/90 border border-red-400/30 px-1.5 py-0.5 leading-none">
                    <img
                      src="/openclaw_icon.svg"
                      alt="OpenClaw"
                      width={14}
                      height={14}
                    />
                    OpenClaw
                  </span>
                )}
              </div>
            )}
            <p className="text-sm text-muted max-w-xl">{talos.description}</p>
            <div className="flex items-center gap-4 mt-3 text-xs text-muted">
              <span>[{talos.category.toUpperCase()}]</span>
              <span>Created {talos.createdAt}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isConnected ? (
            <>
              {isPatron ? (
                <span className="border border-accent/30 text-accent px-5 py-2 text-sm font-bold">
                  Patron
                </span>
              ) : (
                <div className="relative group">
                  <button
                    onClick={handleBecomePatron}
                    disabled={!meetsThreshold || patronStatus === "loading"}
                    className={`px-5 py-2 text-sm font-medium transition-colors ${
                      meetsThreshold
                        ? "bg-accent text-background hover:bg-foreground"
                        : "bg-surface text-muted border border-border cursor-not-allowed"
                    }`}
                  >
                    {patronStatus === "loading"
                      ? "Registering..."
                      : "Become Patron"}
                  </button>
                  {!meetsThreshold && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-surface border border-border text-xs text-muted whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      {minRequired.toLocaleString()} {talos.tokenSymbol}{" "}
                      required
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={openBuyModal}
                className="border border-accent/40 text-accent px-5 py-2 text-sm font-medium hover:bg-accent hover:text-background transition-colors"
              >
                Buy ${talos.tokenSymbol}
              </button>
            </>
          ) : (
            <button
              onClick={connect}
              className="bg-accent text-background px-5 py-2 text-sm font-medium hover:bg-foreground transition-colors flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
              </svg>
              Connect to Invest
            </button>
          )}
        </div>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-px bg-border mb-8">
        {[
          { label: `${talos.tokenSymbol} Price`, value: talos.pulsePrice },
          { label: "Patrons", value: talos.patronCount.toString() },
          { label: "Treasury", value: talos.revenue },
          { label: "Jobs Done", value: talos.jobStats.completed.toString() },
          {
            label: "Success Rate",
            value:
              talos.jobStats.successRate !== null
                ? `${talos.jobStats.successRate}%`
                : "—",
          },
        ].map((s) => (
          <div
            key={s.label}
            className="bg-surface px-4 py-4 text-center"
          >
            <div className="text-lg font-bold text-accent">{s.value}</div>
            <div className="text-xs text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-4 sm:gap-6 border-b border-border mb-8 overflow-x-auto scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-3 pt-1 text-sm transition-colors whitespace-nowrap shrink-0 ${
              tab === t
                ? "text-accent border-b border-accent"
                : "text-muted hover:text-foreground"
            }`}
          >
            {t}
            {t === "Services" && talos.service && (
              <span className="ml-1.5 text-xs text-accent/60">1</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === "Overview" && (
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {/* Service highlight (if available) */}
            {talos.service && (
              <div className="bg-surface border border-accent/20 p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-xs text-accent">[SERVICE OFFERED]</div>
                  <button
                    onClick={() => setTab("Services")}
                    className="text-xs text-muted hover:text-accent transition-colors"
                  >
                    Details &rarr;
                  </button>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-bold text-foreground">{talos.service.name}</h3>
                    {talos.service.description && (
                      <p className="text-xs text-muted mt-1 max-w-md">{talos.service.description}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold text-accent">
                      {talos.service.price} {talos.service.currency}
                    </div>
                    <div className="text-xs text-muted">per request</div>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-border flex items-center gap-4 text-xs text-muted">
                  <span>{talos.jobStats.completed} jobs completed</span>
                  {talos.jobStats.successRate !== null && (
                    <span className={talos.jobStats.successRate >= 90 ? "text-accent font-bold" : talos.jobStats.successRate >= 70 ? "text-muted" : "text-red-600"}>
                      {talos.jobStats.successRate}% success rate
                    </span>
                  )}
                  <span>Chains: {talos.service.chains.join(", ")}</span>
                </div>
              </div>
            )}

            {/* Kernel Policy */}
            <div className="bg-surface border border-border p-6">
              <div className="text-xs text-muted mb-4">[KERNEL POLICY]</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted">Approval Threshold</span>
                  <p className="text-foreground mt-1">&gt; ${talos.approvalThreshold} USDC</p>
                </div>
                <div>
                  <span className="text-muted">GTM Budget</span>
                  <p className="text-foreground mt-1">${talos.gtmBudget}/month</p>
                </div>
                <div>
                  <span className="text-muted">Min Patron {talos.tokenSymbol}</span>
                  <p className="text-foreground mt-1">{minRequired.toLocaleString()} {talos.tokenSymbol}</p>
                </div>
                <div>
                  <span className="text-muted">Channels</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {talos.channels.map((ch) => (
                      <span key={ch} className="text-xs border border-border px-2 py-0.5 text-foreground">{ch}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Prime Agent */}
            <div className="bg-surface border border-border p-6">
              <div className="text-xs text-muted mb-4">[PRIME AGENT]</div>
              <div className="space-y-4 text-sm">
                <div>
                  <span className="text-muted">Persona</span>
                  <p className="text-foreground mt-1">{talos.persona}</p>
                </div>
                <div>
                  <span className="text-muted">Target Audience</span>
                  <p className="text-foreground mt-1">{talos.targetAudience}</p>
                </div>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="bg-surface border border-border p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs text-muted">[RECENT ACTIVITY]</div>
                <button onClick={() => setTab("Activity")} className="text-xs text-muted hover:text-accent transition-colors">
                  View all &rarr;
                </button>
              </div>
              <div className="space-y-3">
                {talos.activities.slice(0, 4).map((a) => (
                  <div key={a.id} className="flex items-start gap-3 py-2 border-b border-border last:border-0">
                    <span className="text-xs text-muted w-5 shrink-0 font-bold">{TYPE_ICONS[a.type]}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-foreground truncate">{a.content}</p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted">
                        <span>{a.channel}</span>
                        <span>{a.timestamp}</span>
                      </div>
                    </div>
                    <span className={`text-xs shrink-0 ${a.status === "completed" ? "text-accent font-bold" : a.status === "pending" ? "text-muted" : "text-red-600"}`}>
                      [{a.status.toUpperCase()}]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right sidebar */}
          <div className="space-y-6">
            {/* Job Performance */}
            {talos.jobStats.total > 0 && (
              <div className="bg-surface border border-border p-6">
                <div className="text-xs text-muted mb-4">[JOB PERFORMANCE]</div>
                <div className="space-y-3">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Total Jobs</span>
                    <span className="text-foreground font-bold">{talos.jobStats.total}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Completed</span>
                    <span className="text-green-400">{talos.jobStats.completed}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Failed</span>
                    <span className="text-red-400">{talos.jobStats.failed}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Pending</span>
                    <span className="text-yellow-400">{talos.jobStats.pending}</span>
                  </div>
                  {talos.jobStats.successRate !== null && (
                    <>
                      <div className="pt-2 border-t border-border">
                        <div className="flex justify-between text-xs mb-1.5">
                          <span className="text-muted">Success Rate</span>
                          <span className={talos.jobStats.successRate >= 90 ? "text-green-400" : talos.jobStats.successRate >= 70 ? "text-yellow-400" : "text-red-400"}>
                            {talos.jobStats.successRate}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-border">
                          <div
                            className={`h-full ${talos.jobStats.successRate >= 90 ? "bg-green-400" : talos.jobStats.successRate >= 70 ? "bg-yellow-400" : "bg-red-400"}`}
                            style={{ width: `${talos.jobStats.successRate}%` }}
                          />
                        </div>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between text-xs pt-2 border-t border-border">
                    <span className="text-muted">Job Revenue</span>
                    <span className="text-accent font-bold">${talos.jobStats.totalRevenue.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Revenue Model */}
            <div className="bg-surface border border-border p-6">
              <div className="text-xs text-muted mb-4">[REVENUE MODEL]</div>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">Model</span>
                  <span className="text-foreground">Agent Treasury</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Revenue Destination</span>
                  <span className="text-accent">100% Agent Wallet</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Creator Earnings</span>
                  <span className="text-foreground">Service Fees</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">{talos.tokenSymbol} Mechanism</span>
                  <span className="text-foreground">Governance + Access</span>
                </div>
                <div className="pt-2 border-t border-border text-muted leading-relaxed">
                  All revenue stays in the agent treasury for operations and {talos.tokenSymbol} buyback &amp; burn. No direct distribution to token holders.
                </div>
              </div>
            </div>

            {/* On-chain */}
            <div className="bg-surface border border-border p-6">
              <div className="text-xs text-muted mb-4">[ON-CHAIN]</div>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">Network</span>
                  <span className="text-foreground">Stellar Network</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted shrink-0">Talos ID</span>
                  <span className="text-foreground font-mono truncate max-w-[55%]">
                    {talos.id.length > 20 ? `${talos.id.slice(0, 10)}...${talos.id.slice(-6)}` : talos.id}
                  </span>
                  <CopyButton
                    value={talos.id}
                    label="Copy Talos ID"
                    confirmText="Copied!"
                    size="sm"
                  />
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted shrink-0">Asset Code</span>
                  <span className="text-foreground font-mono truncate text-right">
                    {talos.stellarAssetCode?.includes(":")
                      ? `${talos.stellarAssetCode.split(":")[0]}:${talos.stellarAssetCode.split(":")[1].slice(0, 6)}…`
                      : talos.stellarAssetCode || talos.tokenSymbol}
                  </span>
                </div>
                {talos.agentWalletAddress && (
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-muted shrink-0">Agent Wallet</span>
                    <span className="text-foreground font-mono truncate max-w-[55%]">{talos.agentWalletAddress.slice(0, 8)}...{talos.agentWalletAddress.slice(-4)}</span>
                    <CopyButton
                      value={talos.agentWalletAddress}
                      label="Copy agent wallet address"
                      confirmText="Copied!"
                      size="sm"
                    />
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted">Total Supply</span>
                  <span className="text-foreground">{talos.totalSupply.toLocaleString()}</span>
                </div>
                {talos.agentWalletAddress && (
                  <a
                    href={`https://stellar.expert/explorer/testnet/account/${talos.agentWalletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-center border border-border py-1.5 text-muted hover:text-accent hover:border-accent transition-colors mt-2"
                  >
                    View on Stellar Expert &rarr;
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "Services" && (
        <div className="space-y-6">
          {talos.service ? (
            <>
              {/* Service card */}
              <div className="bg-surface border border-border p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-xs text-accent">[AVAILABLE SERVICE]</div>
                  <span
                    className={`text-xs ${
                      talos.agentOnline ? "text-green-400" : "text-muted"
                    }`}
                  >
                    {talos.agentOnline ? "[ACCEPTING REQUESTS]" : "[OFFLINE]"}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-foreground mb-2">{talos.service.name}</h3>
                {talos.service.description && (
                  <p className="text-sm text-muted mb-4">{talos.service.description}</p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div>
                    <span className="text-muted text-xs">Price</span>
                    <p className="text-accent font-bold mt-1">
                      {talos.service.price} {talos.service.currency}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted text-xs">Payment</span>
                    <p className="text-foreground mt-1">x402 on Stellar</p>
                  </div>
                  <div>
                    <span className="text-muted text-xs">Chains</span>
                    <p className="text-foreground mt-1">{talos.service.chains.join(", ")}</p>
                  </div>
                  <div>
                    <span className="text-muted text-xs">Wallet</span>
                    <div className="text-foreground mt-1 font-mono text-xs truncate flex items-center gap-1">
                      <span className="truncate">{talos.service.stellarPublicKey}</span>
                      <CopyButton
                        value={talos.service.stellarPublicKey}
                        label="Copy service wallet address"
                        confirmText="Copied!"
                        size="sm"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Request Service button */}
              {isConnected ? (
                <div className="bg-surface border border-accent/20 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-xs text-accent">[REQUEST SERVICE]</div>
                    <span className="text-xs text-muted">
                      Pay {talos.service.price} {talos.service.currency} · wallet signing required
                    </span>
                  </div>
                  <p className="text-xs text-muted mb-4">
                    Submit a job to this agent. Your USDC payment is sent on-chain and the agent processes your request.
                  </p>
                  <button
                    onClick={() => { setServiceOpen(true); setServiceStatus("idle"); setServiceResult(null); }}
                    disabled={!talos.agentOnline}
                    className={`px-6 py-2.5 text-sm font-medium transition-colors ${
                      talos.agentOnline
                        ? "bg-accent text-background hover:bg-foreground"
                        : "bg-surface text-muted border border-border cursor-not-allowed"
                    }`}
                  >
                    {talos.agentOnline ? `Request — ${talos.service.price} USDC` : "Agent Offline"}
                  </button>
                </div>
              ) : (
                <div className="bg-surface border border-border p-6 text-center">
                  <p className="text-sm text-muted mb-4">Connect your wallet to request this service</p>
                  <button onClick={connect} className="bg-accent text-background px-6 py-2.5 text-sm font-medium hover:bg-foreground transition-colors">
                    Connect Wallet
                  </button>
                </div>
              )}

              {/* Integration guide */}
              <div className="bg-surface border border-border p-6">
                <div className="text-xs text-muted mb-4">[API INTEGRATION]</div>
                <p className="text-xs text-muted mb-4">
                  Integrate programmatically — pay USDC on-chain, then call the jobs endpoint.
                </p>
                <div className="bg-background border border-border p-4 text-xs text-foreground overflow-x-auto font-mono space-y-1">
                  <div className="text-green-400"># 1. Send USDC payment on Stellar</div>
                  <div className="text-muted">destination: {talos.service.stellarPublicKey.slice(0, 12)}...</div>
                  <div className="text-muted">amount: {talos.service.price} USDC</div>
                  <div className="mt-3 text-green-400"># 2. Create job with txHash</div>
                  <div className="text-muted">POST /api/talos/{talos.id}/jobs</div>
                  <div className="mt-1">{"{"}</div>
                  <div className="pl-4">&quot;buyerPublicKey&quot;: &quot;G...&quot;,</div>
                  <div className="pl-4">&quot;txHash&quot;: &quot;&lt;stellar_tx_hash&gt;&quot;,</div>
                  <div className="pl-4">&quot;payload&quot;: {"{"} &quot;request&quot;: &quot;your task here&quot; {"}"}</div>
                  <div>{"}"}</div>
                  <div className="mt-3 text-green-400"># 3. Poll for result</div>
                  <div className="text-muted">GET /api/talos/{talos.id}/jobs?jobId=:id</div>
                </div>
              </div>

              {/* Recent jobs */}
              {talos.recentJobs.length > 0 && (
                <div className="bg-surface border border-border p-6">
                  <div className="text-xs text-muted mb-4">[RECENT JOBS]</div>
                  <div className="space-y-2">
                    {talos.recentJobs.map((job) => (
                      <div key={job.id} className="flex items-center justify-between py-2 border-b border-border last:border-0 text-xs">
                        <div className="flex items-center gap-3">
                          <span className={JOB_STATUS_STYLES[job.status] ?? "text-muted"}>
                            [{job.status.toUpperCase()}]
                          </span>
                          <span className="text-foreground">{job.serviceName}</span>
                        </div>
                        <div className="flex items-center gap-4 text-muted">
                          <span>${job.amount}</span>
                          <span>{job.createdAt}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <AgentEmptyState kind="service" />
          )}
        </div>
      )}

      {tab === "Activity" && (
        <TabActivity activities={talos.activities} />
      )}

      {tab === "Patrons" && (
        <TabPatrons
          talos={talos}
          minRequired={minRequired}
          address={address ?? undefined}
          isConnected={isConnected}
          onBuyToken={openBuyModal}
        />
      )}

      {tab === "Revenue" && (
        <TabRevenue
          talos={talos}
          address={address ?? undefined}
          isConnected={isConnected}
          distPreview={distPreview}
          distLoading={distLoading}
          onLoadDistPreview={loadDistPreview}
          onDistribute={handleDistribute}
          buybackPreview={buybackPreview}
          buybackLoading={buybackLoading}
          buybackForm={buybackForm}
          onBuybackFormChange={(field: string, value: string) =>
            setBuybackForm((f) => ({ ...f, [field]: value }))
          }
          onLoadBuybackPreview={loadBuybackPreview}
          onBuyback={handleBuyback}
        />
      )}

      {tab === "Purchases" && (
        <AgentPurchasesSection
          talosId={talos.id}
          isOwner={isAgentOwner}
          address={address ?? null}
          signMessage={signMessage}
          connect={connect}
        />
      )}

      {tab === "Governance" && (
        <TabGovernance
          talos={talos}
          address={address ?? undefined}

          isConnected={isConnected}
          isPatron={isPatron}
          approvals={approvals}
          approvalsLoaded={approvalsLoaded}
          proposeOpen={proposeOpen}
          proposeForm={proposeForm}
          proposeLoading={proposeLoading}
          onLoadApprovals={loadApprovals}
          onVote={handleVote}
          onOpenPropose={() => setProposeOpen(true)}
          onClosePropose={() => setProposeOpen(false)}
          onProposeFormChange={(field: string, value: string) =>
            setProposeForm((f) => ({ ...f, [field]: value }))
          }
          onPropose={handlePropose}
        />
      )}

      {/* ─── Agent Tab ──────────────────────────────────── */}
      {tab === "Agent" && (
        <div className="space-y-6">
          {isAgentOwner && address && (
            <ScopedApiKeysPanel
              talosId={talos.id}
              address={address}
              signMessage={signMessage}
            />
          )}
          <TabAgent talos={talos} />
        </div>
      )}


      {/* Buy Token Modal */}
      {buyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={closeBuyModal} />
          <div className="relative bg-background border border-border w-full max-w-md mx-4 p-0">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="text-xs text-accent tracking-wider">[BUY ${talos.tokenSymbol}]</div>
              <button onClick={closeBuyModal} className="text-muted hover:text-foreground text-sm">
                &times;
              </button>
            </div>

            {buyStatus === "success" && buyResult ? (
              /* ─── Success state ─── */
              <div className="px-6 py-8 text-center">
                <div className="w-12 h-12 mx-auto mb-4 border border-green-400/40 flex items-center justify-center text-green-400 text-lg">
                  &#10003;
                </div>
                <p className="text-sm text-foreground mb-2">Purchase Complete</p>
                <p className="text-xs text-muted mb-4">{buyResult.message}</p>
                <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-6 flex items-center gap-2">
                  <span className="break-all">tx: {buyResult.txHash.slice(0, 18)}...{buyResult.txHash.slice(-8)}</span>
                  <CopyButton
                    value={buyResult.txHash}
                    label="Copy transaction hash"
                    confirmText="Copied!"
                    size="sm"
                  />
                </div>
                <button
                  onClick={closeBuyModal}
                  className="bg-accent text-background px-8 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              /* ─── Purchase form ─── */
              <div className="px-6 py-6 space-y-5">
                {/* Token info */}
                <div className="flex items-center gap-3">
                  <AgentAvatar name={talos.agentName || talos.name} size={36} />
                  <div>
                    <div className="text-sm font-bold text-foreground">{talos.name}</div>
                    <div className="text-xs text-muted">{talos.tokenSymbol} &middot; Fixed Price {talos.pulsePrice}/token</div>
                  </div>
                </div>

                {/* Amount input */}
                <div>
                  <label className="text-xs text-muted block mb-1.5">Amount ({talos.tokenSymbol})</label>
                  <input
                    ref={buyInputRef}
                    type="number"
                    min={1}
                    step={1}
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(e.target.value)}
                    placeholder="e.g. 1000"
                    className="w-full bg-surface border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/40 focus:outline-none focus:border-accent"
                  />
                  <div className="flex items-center gap-2 mt-2">
                    {[100, 1000, 10000].map((preset) => (
                      <button
                        key={preset}
                        onClick={() => setBuyAmount(String(preset))}
                        className="text-xs border border-border px-2 py-1 text-muted hover:text-accent hover:border-accent transition-colors"
                      >
                        {preset.toLocaleString()}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Cost breakdown */}
                <div className="bg-surface border border-border p-4 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Token Price</span>
                    <span className="text-foreground">{talos.pulsePrice} USDC</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Quantity</span>
                    <span className="text-foreground">{buyQty.toLocaleString()} {talos.tokenSymbol}</span>
                  </div>
                  <div className="flex justify-between text-sm pt-2 border-t border-border">
                    <span className="text-muted">Total Cost</span>
                    <span className="text-accent font-bold">${buyCost.toFixed(2)} USDC</span>
                  </div>
                </div>

                {/* Buy button */}
                <button
                  onClick={handleBuyToken}
                  disabled={buyQty <= 0 || buyStatus === "buying"}
                  className={`w-full py-3 text-sm font-medium transition-colors ${
                    buyQty > 0
                      ? "bg-accent text-background hover:bg-foreground"
                      : "bg-surface text-muted border border-border cursor-not-allowed"
                  }`}
                >
                  {buyStatus === "buying"
                    ? "Processing..."
                    : buyQty > 0
                      ? `Buy ${buyQty.toLocaleString()} ${talos.tokenSymbol} for $${buyCost.toFixed(2)}`
                      : `Enter amount to buy`}
                </button>

                <p className="text-xs text-muted/50 text-center">
                  Stellar testnet &mdash; real transaction, real tokens
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Service Request Modal */}
      {serviceOpen && talos.service && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { if (!serviceStatus.match(/paying/)) { if (retryIntervalRef.current !== null) { clearInterval(retryIntervalRef.current); retryIntervalRef.current = null; } setServiceOpen(false); setServiceError(null); setServiceStatus("idle"); setRetryCountdown(0); } }} />
          <div className="relative bg-background border border-border w-full max-w-md mx-4 p-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="text-xs text-accent tracking-wider">[REQUEST SERVICE]</div>
              <button onClick={() => { if (retryIntervalRef.current !== null) { clearInterval(retryIntervalRef.current); retryIntervalRef.current = null; } setServiceOpen(false); setServiceError(null); setServiceStatus("idle"); setRetryCountdown(0); }} className="text-muted hover:text-foreground text-sm">&times;</button>
            </div>

            {serviceStatus === "success" && serviceResult ? (
              <div className="px-6 py-8 text-center">
                <div className="w-12 h-12 mx-auto mb-4 border border-green-400/40 flex items-center justify-center text-green-400 text-lg">&#10003;</div>
                <p className="text-sm text-foreground mb-2">Job Submitted</p>
                <p className="text-xs text-muted mb-4">The agent will process your request. Poll for results using your job ID.</p>
                <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-2 flex items-center gap-2">
                  <span className="break-all">job: {serviceResult.jobId}</span>
                  <CopyButton
                    value={serviceResult.jobId}
                    label="Copy job id"
                    confirmText="Copied!"
                    size="sm"
                  />
                </div>
                <div className="bg-surface border border-border p-3 text-xs font-mono text-muted break-all mb-6 flex items-center gap-2">
                  <span className="break-all">tx: {serviceResult.txHash.slice(0, 18)}...{serviceResult.txHash.slice(-8)}</span>
                  <CopyButton
                    value={serviceResult.txHash}
                    label="Copy transaction hash"
                    confirmText="Copied!"
                    size="sm"
                  />
                </div>
                {serviceResult.status === "completed" && serviceResult.result ? (
                  <div className="bg-surface border border-accent/20 p-4 text-left mb-4">
                    <div className="text-xs text-accent mb-2">[RESULT]</div>
                    <pre className="text-xs text-foreground overflow-x-auto whitespace-pre-wrap font-mono max-h-48">
                      {JSON.stringify(serviceResult.result, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <div className="text-xs text-muted mb-4">
                    Poll for result: <span className="font-mono">GET /api/talos/{talos.id}/jobs?jobId={serviceResult.jobId}</span>
                  </div>
                )}
                <button
                  onClick={() => setServiceOpen(false)}
                  className="bg-accent text-background px-8 py-2.5 text-sm font-medium hover:bg-foreground transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="px-6 py-6 space-y-5">
                <div>
                  <div className="text-sm font-bold text-foreground">{talos.service.name}</div>
                  {talos.service.description && (
                    <p className="text-xs text-muted mt-1">{talos.service.description}</p>
                  )}
                </div>

                {/* Inline error with retry guidance */}
                {serviceStatus === "error" && serviceError && (
                  <div className="bg-red-950/30 border border-red-800/50 p-4 space-y-3">
                    <div className="flex items-start gap-2">
                      <span className="text-red-400 text-xs font-bold shrink-0">[ERROR]</span>
                      <p className="text-xs text-red-300 leading-relaxed">{serviceError.message}</p>
                    </div>
                    {serviceError.retryable ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted">
                          This is a transient network error — the transaction did not reach the network. You can safely retry.
                        </p>
                        <button
                          onClick={() => {
                            if (retryIntervalRef.current !== null) {
                              clearInterval(retryIntervalRef.current);
                              retryIntervalRef.current = null;
                            }
                            setServiceStatus("idle");
                            setServiceError(null);
                            setRetryCountdown(0);
                          }}
                          disabled={retryCountdown > 0}
                          className="w-full py-2 text-xs font-medium border border-accent text-accent hover:bg-accent hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {retryCountdown > 0 ? `Retry in ${retryCountdown}s…` : "Retry Purchase"}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        This error cannot be retried. Your payment may have been submitted — check your wallet and contact support if needed.
                      </p>
                    )}
                  </div>
                )}

                <div>
                  <label className="text-xs text-muted block mb-1.5">Request / Payload (optional JSON or plain text)</label>
                  <textarea
                    rows={4}
                    value={servicePayload}
                    onChange={(e) => setServicePayload(e.target.value)}
                    placeholder={`{"request": "describe what you want the agent to do"}`}
                    className="w-full bg-surface border border-border px-4 py-2.5 text-xs text-foreground placeholder:text-muted/40 focus:outline-none focus:border-accent font-mono resize-none"
                  />
                </div>

                <div className="bg-surface border border-border p-4 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Service Price</span>
                    <span className="text-accent font-bold">{talos.service.price} {talos.service.currency}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted">Payment</span>
                    <span className="text-foreground">Stellar · wallet signing</span>
                  </div>
                </div>

                <button
                  onClick={handleRequestService}
                  disabled={serviceStatus === "paying" || retryCountdown > 0}
                  className="w-full py-3 text-sm font-medium bg-accent text-background hover:bg-foreground transition-colors disabled:opacity-50"
                >
                  {serviceStatus === "paying" ? "Processing payment..." : `Pay ${talos.service.price} USDC & Submit Job`}
                </button>

                <p className="text-xs text-muted/50 text-center">
                  USDC is transferred on-chain before job creation
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
