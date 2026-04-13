"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { WalletGate, useWallet } from "@/components/wallet-gate";
import { useStellarWallet } from "@/components/providers";
import {
  isNameAvailableOnChain,
  ensureStellarNetwork,
  getNetwork,
  TALOS_REGISTRY_CONTRACT_ID,
  TALOS_NAME_SERVICE_CONTRACT_ID,
} from "@/lib/soroban";

const STEPS = [
  "Product",
  "Patron",
  "Mitos",
  "Kernel",
  "Agent",
  "Review",
] as const;

const CHANNELS = ["X (Twitter)", "LinkedIn", "Reddit", "Product Hunt"];

export default function LaunchPage() {
  return (
    <WalletGate
      title="Connect Wallet to Launch"
      description="Creating a TALOS requires a Stellar wallet connection. Your public key will be registered as the Creator."
    >
      <LaunchForm />
    </WalletGate>
  );
}

function LaunchForm() {
  const { address } = useWallet();
  const { signTransaction } = useStellarWallet();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    productName: "",
    productDesc: "",
    category: "marketing",
    tokenName: "",
    tokenSymbol: "",
    totalSupply: "1000000",
    initialPrice: "0.01",
    approvalThreshold: "10",
    gtmBudget: "100",
    persona: "",
    targetAudience: "",
    tone: "professional",
    creatorWallet: "",
    channels: ["X (Twitter)"] as string[],
    agentName: "",
    serviceName: "",
    serviceDescription: "",
    servicePrice: "",
    serviceCurrency: "USDC" as const,
  });
  const [nameAvailable, setNameAvailable] = useState<boolean | null>(null);
  const [nameChecking, setNameChecking] = useState(false);
  const [deployStep, setDeployStep] = useState<string | null>(null);
  const [deployProgress, setDeployProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const [genesisResult, setGenesisResult] = useState<{
    talosId: string;
    apiKey: string;
    onChainId: number | null;
    agentName: string;
  } | null>(null);

  const update = (key: string, value: string | number | string[]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkNameAvailability = useCallback((name: string) => {
    if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    if (!name || name.length < 3) {
      setNameAvailable(null);
      setNameChecking(false);
      return;
    }
    setNameChecking(true);
    nameCheckTimer.current = setTimeout(async () => {
      try {
        const [onChainAvailable, dbResult] = await Promise.all([
          isNameAvailableOnChain(name),
          fetch(`/api/talos/check-name?name=${encodeURIComponent(name)}`)
            .then((r) => r.json())
            .then((d) => d.available as boolean)
            .catch(() => true),
        ]);
        setNameAvailable(onChainAvailable && dbResult);
      } catch {
        const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && !/--/.test(name);
        setNameAvailable(valid);
      } finally {
        setNameChecking(false);
      }
    }, 400);
  }, []);

  const canNext = () => {
    switch (step) {
      case 0:
        return form.productName && form.productDesc;
      case 1:
        return true;
      case 2: {
        const sym = form.tokenSymbol.trim();
        const supply = Number(form.totalSupply);
        const price = Number(form.initialPrice);
        return (
          form.tokenName.trim().length > 0 &&
          sym.length >= 2 && sym.length <= 8 &&
          /^[A-Za-z][A-Za-z0-9]*$/.test(sym) &&
          supply > 0 && supply <= 100_000_000 &&
          price > 0 && price <= 1_000_000
        );
      }
      case 3:
        return form.approvalThreshold && form.gtmBudget;
      case 4:
        return form.persona && form.targetAudience && form.channels.length > 0
          && form.agentName.length >= 3 && nameAvailable === true;
      default:
        return true;
    }
  };

  const handleLaunch = async () => {
    if (!address) return;
    setSubmitting(true);
    setError(null);
    setDeployStep(null);
    setDeployProgress(0);

    let onChainId: number | null = null;

    try {
      // 1. Verify Stellar wallet
      setDeployStep("Verifying Stellar wallet...");
      setDeployProgress(1);
      await ensureStellarNetwork(address);

      const creatorAddr = form.creatorWallet || address;

      // 2. Register TALOS on-chain via Soroban (if contract is deployed)
      if (TALOS_REGISTRY_CONTRACT_ID) {
        setDeployStep("Registering TALOS on Soroban...");
        setDeployProgress(2);

        const { TransactionBuilder, BASE_FEE, Account, Contract, nativeToScVal, scValToNative, rpc, xdr } =
          await import("@stellar/stellar-sdk");
        const network = getNetwork();
        const server = new rpc.Server(network.sorobanRpc);
        const account = await server.getAccount(address);

        const registry = new Contract(TALOS_REGISTRY_CONTRACT_ID);
        const categoryCapitalized = form.category.charAt(0).toUpperCase() + form.category.slice(1);

        const OPERATOR = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL";

        // Helper: build an ScMap entry (key as Symbol, value as ScVal)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scEntry = (key: string, val: any) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

        // Helper: i128 ScVal from a number
        const scI128 = (n: number) =>
          nativeToScVal(BigInt(Math.round(n)), { type: "i128" });

        // Patron struct — fields MUST be in alphabetical order for Soroban ScMap
        const patronVal = xdr.ScVal.scvMap([
          scEntry("creator_addr",  nativeToScVal(creatorAddr, { type: "address" })),
          scEntry("creator_share", xdr.ScVal.scvU32(60)),
          scEntry("investor_addr", nativeToScVal(creatorAddr, { type: "address" })),
          scEntry("investor_share", xdr.ScVal.scvU32(25)),
          scEntry("treasury_addr", nativeToScVal(OPERATOR, { type: "address" })),
          scEntry("treasury_share", xdr.ScVal.scvU32(15)),
        ]);

        // Kernel struct (alphabetical)
        const kernelVal = xdr.ScVal.scvMap([
          scEntry("approval_threshold", scI128(Number(form.approvalThreshold) || 10)),
          scEntry("gtm_budget",         scI128(Number(form.gtmBudget) || 100)),
          scEntry("min_patron_pulse",   scI128(100)),
        ]);

        // Pulse struct (alphabetical)
        const pulseVal = xdr.ScVal.scvMap([
          scEntry("price_usd_cents", scI128(Math.round(parseFloat(form.initialPrice || "0.01") * 100))),
          scEntry("token_symbol",    nativeToScVal(form.tokenSymbol.toUpperCase(), { type: "string" })),
          scEntry("total_supply",    scI128(Number(form.totalSupply) || 1_000_000)),
        ]);

        const tx = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
          fee: BASE_FEE,
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(
            registry.call(
              "create_talos",
              nativeToScVal(form.productName,       { type: "string" }),
              nativeToScVal(categoryCapitalized,    { type: "string" }),
              nativeToScVal(form.persona || form.productDesc, { type: "string" }),
              patronVal,
              kernelVal,
              pulseVal,
              nativeToScVal(OPERATOR, { type: "address" }),
            ),
          )
          .setTimeout(60)
          .build();

        const preparedTx = await server.prepareTransaction(tx);
        const signedXdr = await signTransaction(preparedTx.toXDR());
        const { TransactionBuilder: TB } = await import("@stellar/stellar-sdk");
        const result = await server.sendTransaction(TB.fromXDR(signedXdr, network.networkPassphrase));

        if (result.status === "ERROR") throw new Error("Soroban transaction failed");

        // Poll for result
        let getResult = await server.getTransaction(result.hash);
        for (let i = 0; i < 10 && getResult.status === "NOT_FOUND"; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          getResult = await server.getTransaction(result.hash);
        }
        if (getResult.status === "SUCCESS" && getResult.returnValue) {
          const raw = scValToNative(getResult.returnValue);
          // create_talos returns u32 — may come back as number or BigInt
          onChainId = typeof raw === "bigint" ? Number(raw) : (raw as number);
        }
      } else {
        // Contracts not deployed yet — skip on-chain step
        setDeployProgress(2);
      }

      // 3. Register agent name on-chain (if name service is deployed)
      if (TALOS_NAME_SERVICE_CONTRACT_ID && onChainId !== null) {
        setDeployStep("Registering agent identity on-chain...");
        setDeployProgress(3);

        const { TransactionBuilder, BASE_FEE, Account, Contract, nativeToScVal, rpc } =
          await import("@stellar/stellar-sdk");
        const network = getNetwork();
        const server = new rpc.Server(network.sorobanRpc);
        const account = await server.getAccount(address);

        const nameService = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
        const tx = new TransactionBuilder(new Account(account.accountId(), account.sequenceNumber()), {
          fee: BASE_FEE,
          networkPassphrase: network.networkPassphrase,
        })
          .addOperation(
            nameService.call(
              "register_name",
              nativeToScVal(onChainId, { type: "u32" }),
              nativeToScVal(form.agentName.toLowerCase().trim(), { type: "string" }),
            ),
          )
          .setTimeout(60)
          .build();

        const preparedTx = await server.prepareTransaction(tx);
        const signedXdr = await signTransaction(preparedTx.toXDR());
        const result = await server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase));
        if (result.status === "ERROR") throw new Error("Name registration failed");

        let getResult = await server.getTransaction(result.hash);
        for (let i = 0; i < 10 && getResult.status === "NOT_FOUND"; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          getResult = await server.getTransaction(result.hash);
        }
      } else {
        setDeployProgress(3);
      }

      // 4. Save to database
      setDeployStep("Saving to database...");
      setDeployProgress(4);

      let dbData: { id: string; apiKeyOnce: string } | null = null;
      try {
        const res = await fetch("/api/talos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.productName,
            category: form.category.charAt(0).toUpperCase() + form.category.slice(1),
            description: form.productDesc,
            totalSupply: Number(form.totalSupply),
            persona: form.persona,
            targetAudience: form.targetAudience,
            channels: form.channels,
            toneVoice: form.tone,
            approvalThreshold: Number(form.approvalThreshold),
            gtmBudget: Number(form.gtmBudget),
            initialPrice: Number(form.initialPrice),
            minPatronPulse: Math.floor(Number(form.totalSupply) / 1000),
            creatorPublicKey: creatorAddr,
            walletPublicKey: address,
            onChainId: onChainId ?? undefined,
            agentName: form.agentName,
            stellarAssetCode: form.tokenSymbol.toUpperCase() || undefined,
            tokenSymbol: form.tokenSymbol,
            ...(form.serviceName && form.servicePrice
              ? {
                  serviceName: form.serviceName,
                  serviceDescription: form.serviceDescription || undefined,
                  servicePrice: Number(form.servicePrice),
                }
              : {}),
          }),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to save TALOS");
        }
        dbData = await res.json();
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : "Database save failed";
        const onChainInfo = onChainId !== null
          ? `On-chain registration succeeded (ID: ${onChainId}, Agent: ${form.agentName}.talos) but database save failed: ${msg}. `
          : `Database save failed: ${msg}. `;
        setError(onChainInfo + "Please contact support to recover.");
        return;
      }

      setGenesisResult({
        talosId: dbData!.id,
        apiKey: dbData!.apiKeyOnce,
        onChainId,
        agentName: form.agentName,
      });
    } catch (err) {
      console.error("[Launch] Error:", err);
      const raw = err instanceof Error ? err.message : "Deployment failed";
      let message = raw;
      if (raw.includes("User declined") || raw.includes("user rejected"))
        message = "Transaction was rejected in your wallet.";
      else if (raw.includes("Account not found"))
        message = raw;
      else if (raw.includes("insufficient") || raw.includes("balance"))
        message = "Insufficient XLM balance for this transaction.";
      else if (raw.length > 200)
        message = "Deployment failed. Please try again or contact support.";
      setError(message);
    } finally {
      setSubmitting(false);
      setDeployStep(null);
      setDeployProgress(0);
    }
  };

  if (genesisResult) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <div className="text-xs text-accent font-bold mb-2">[GENESIS COMPLETE]</div>
          <h1 className="text-2xl font-bold text-accent">TALOS Launched Successfully</h1>
        </div>

        <div className="bg-surface border border-accent/30 p-8 mb-6 space-y-6">
          {genesisResult.onChainId !== null && (
            <div className="flex items-center gap-3 text-accent font-bold">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span className="text-sm font-medium">On-chain registration confirmed (ID: {genesisResult.onChainId})</span>
            </div>
          )}

          <div>
            <div className="text-xs text-muted mb-2">Agent Identity</div>
            <div className="text-foreground font-mono text-sm">{genesisResult.agentName}.talos</div>
          </div>

          <div>
            <div className="text-xs text-accent font-bold mb-2">API Key (shown only once — save it now)</div>
            <div className="bg-background border border-border p-3 font-mono text-xs text-accent break-all select-all">
              {genesisResult.apiKey}
            </div>
          </div>

          <div>
            <div className="text-xs text-muted mb-4">Run your Prime Agent</div>
            <div className="bg-background border border-border p-4 text-xs text-foreground space-y-1 overflow-x-auto">
              <div className="text-muted"># 1. Install the agent CLI</div>
              <div>pip install talos-agent</div>
              <div className="text-muted mt-3"># 2. Set your API key</div>
              <div>export TALOS_API_KEY=&quot;{genesisResult.apiKey}&quot;</div>
              <div className="text-muted mt-3"># 3. Start your Prime Agent</div>
              <div>talos-agent start --talos-id {genesisResult.talosId}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-between">
          <button
            onClick={() => {
              navigator.clipboard.writeText(genesisResult.apiKey).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
            className={`px-6 py-2.5 text-sm border transition-colors ${
              copied ? "border-accent text-accent font-bold" : "border-border text-foreground hover:bg-surface-hover"
            }`}
          >
            {copied ? "Copied!" : "Copy API Key"}
          </button>
          <button
            onClick={() => router.push(`/agents/${genesisResult.talosId}`)}
            className="px-8 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors"
          >
            View TALOS &rarr;
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="text-xs text-muted mb-2">[TALOS GENESIS]</div>
          <h1 className="text-2xl font-bold text-accent">Launch your TALOS</h1>
        </div>
        <button
          onClick={() => {
            setForm({
              productName: "Nexus",
              productDesc: "AI-powered payment agent that automates invoicing, subscription billing, and cross-border settlements. Integrates with major payment rails and provides real-time treasury analytics for Web3 businesses.",
              category: "finance",
              tokenName: "Nexus Mitos",
              tokenSymbol: "NEXUS",
              totalSupply: "1000000",
              initialPrice: "0.50",
              approvalThreshold: "100",
              gtmBudget: "500",
              persona: "A sharp, data-driven fintech strategist who speaks with authority on payments infrastructure. Combines deep technical knowledge with clear, actionable insights. Always backs claims with numbers.",
              targetAudience: "Web3 founders, CFOs, and treasury managers who need automated payment operations and real-time financial visibility.",
              tone: "professional",
              creatorWallet: "",
              channels: ["X (Twitter)", "LinkedIn"],
              agentName: "nexus",
              serviceName: "Payment Automation",
              serviceDescription: "Automates invoice generation, payment routing, and settlement reconciliation. Send a payment request and receive a fully processed transaction with compliance checks.",
              servicePrice: "2.50",
              serviceCurrency: "USDC",
            });
            checkNameAvailability("nexus");
            setStep(0);
          }}
          className="px-4 py-2 text-xs border border-accent/30 text-accent hover:bg-surface-hover transition-colors"
        >
          Demo: Nexus
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-10 overflow-x-auto">
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => i <= step && setStep(i)}
            className={`px-3 py-1.5 text-xs border transition-colors whitespace-nowrap ${
              i === step
                ? "border-accent text-accent bg-surface"
                : i < step
                ? "border-border text-foreground bg-surface cursor-pointer hover:bg-surface-hover"
                : "border-border text-muted bg-background cursor-default"
            }`}
          >
            {String(i + 1).padStart(2, "0")} {s}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="bg-surface border border-border p-8 mb-6">
        {step === 0 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Product Input</h2>
            <p className="text-sm text-muted mb-6">
              Register your product. Your Prime Agent will handle GTM and service delivery.
            </p>
            <Field label="Product Name" value={form.productName} onChange={(v) => update("productName", v)} placeholder="e.g. ImageGen Pro" />
            <Field label="Description" value={form.productDesc} onChange={(v) => update("productDesc", v)} placeholder="What does your product do? Who is it for?" multiline />
            <div>
              <label className="block text-xs text-muted mb-2">Category</label>
              <select
                value={form.category}
                onChange={(e) => update("category", e.target.value)}
                className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
              >
                <option value="marketing">Marketing</option>
                <option value="development">Development</option>
                <option value="research">Research</option>
                <option value="design">Design</option>
                <option value="finance">Finance</option>
                <option value="analytics">Analytics</option>
                <option value="operations">Operations</option>
                <option value="sales">Sales</option>
                <option value="support">Support</option>
                <option value="education">Education</option>
              </select>
            </div>

            <div className="pt-4 mt-2 border-t border-border">
              <div className="text-xs text-accent mb-1">[COMMERCE SERVICE]</div>
              <p className="text-xs text-muted mb-4">
                Define the paid service your agent offers to other agents via the x402 protocol. Optional — you can add this later.
              </p>
              <div className="space-y-4">
                <Field label="Service Name" value={form.serviceName} onChange={(v) => update("serviceName", v)} placeholder="e.g. SEO Content Generation" />
                <Field label="Service Description" value={form.serviceDescription} onChange={(v) => update("serviceDescription", v)} placeholder="What does this service do? What input/output should callers expect?" multiline />
                <div>
                  <label className="block text-xs text-muted mb-2">Price per Request (USDC)</label>
                  <input
                    type="number"
                    value={form.servicePrice}
                    onChange={(e) => update("servicePrice", e.target.value)}
                    placeholder="e.g. 5.00"
                    className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Patron Configuration</h2>
            <p className="text-sm text-muted mb-6">
              The Creator is your Stellar public key. It is permanently linked to this TALOS and cannot be changed.
            </p>
            <div>
              <label className="block text-xs text-muted mb-2">Creator Public Key (Stellar)</label>
              <div className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground/70 font-mono select-all break-all">
                {form.creatorWallet || address || "—"}
              </div>
              <p className="text-xs text-muted mt-1">This Stellar public key will be registered as the TALOS Creator on-chain.</p>
            </div>
            <div className="p-4 border border-border bg-background">
              <div className="text-xs text-accent mb-2">[REVENUE MODEL]</div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">Agent Treasury</span>
                  <span className="text-foreground font-medium">100%</span>
                </div>
              </div>
              <p className="text-xs text-muted mt-3">All revenue flows to the Agent Treasury controlled by the Creator.</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Mitos Configuration</h2>
            <p className="text-sm text-muted mb-6">
              Configure your TALOS&apos;s Mitos token on Stellar.
            </p>
            <Field label="Token Name" value={form.tokenName} onChange={(v) => update("tokenName", v)} placeholder="e.g. ImageGen Mitos" />
            <div>
              <Field label="Token Symbol (Stellar Asset Code)" value={form.tokenSymbol} onChange={(v) => update("tokenSymbol", v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))} placeholder="e.g. IMGS" />
              <p className="text-xs text-muted mt-1">2-8 characters, letters and numbers only. Used as Stellar asset code.</p>
            </div>
            <div>
              <Field label="Total Supply" value={form.totalSupply} onChange={(v) => update("totalSupply", v)} type="number" />
              <p className="text-xs text-muted mt-1">Max 100,000,000</p>
            </div>
            <div>
              <Field label="Initial Price (USDC)" value={form.initialPrice} onChange={(v) => update("initialPrice", v)} type="number" />
              <p className="text-xs text-muted mt-1">Price per Pulse token in USDC on Stellar</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Kernel Policy</h2>
            <p className="text-sm text-muted mb-6">
              Set the governance rules for your agent.
            </p>
            <Field label="Approval Threshold (USDC)" value={form.approvalThreshold} onChange={(v) => update("approvalThreshold", v)} type="number" placeholder="Transactions above this require approval" />
            <Field label="GTM Budget (USDC/month)" value={form.gtmBudget} onChange={(v) => update("gtmBudget", v)} type="number" placeholder="Monthly budget for GTM activities" />
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Prime Agent Setup</h2>
            <p className="text-sm text-muted mb-6">
              Configure your AI agent&apos;s personality and targets.
            </p>
            <div>
              <label className="block text-xs text-muted mb-2">Agent Identity (immutable)</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={form.agentName}
                  onChange={(e) => {
                    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                    update("agentName", v);
                    checkNameAvailability(v);
                  }}
                  placeholder="e.g. marketbot"
                  className="flex-1 bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                />
                <span className="text-sm text-muted">.talos</span>
              </div>
              <div className="mt-1.5 text-xs">
                {nameChecking && <span className="text-muted">Checking...</span>}
                {!nameChecking && nameAvailable === true && form.agentName.length >= 3 && (
                  <span className="text-accent font-bold">{form.agentName}.talos is available</span>
                )}
                {!nameChecking && nameAvailable === false && (
                  <span className="text-red-600 font-bold">{form.agentName}.talos is taken</span>
                )}
                {!nameChecking && nameAvailable === null && form.agentName.length > 0 && form.agentName.length < 3 && (
                  <span className="text-muted">Minimum 3 characters</span>
                )}
              </div>
              <p className="text-xs text-muted mt-1">This is your agent&apos;s permanent on-chain identity. It cannot be changed after registration.</p>
            </div>
            <Field label="Persona" value={form.persona} onChange={(v) => update("persona", v)} placeholder="e.g. A sharp, witty tech commentator" multiline />
            <Field label="Target Audience" value={form.targetAudience} onChange={(v) => update("targetAudience", v)} placeholder="e.g. Indie developers building SaaS products" />
            <div>
              <label className="block text-xs text-muted mb-2">Tone</label>
              <select
                value={form.tone}
                onChange={(e) => update("tone", e.target.value)}
                className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
              >
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="witty">Witty</option>
                <option value="technical">Technical</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-2">GTM Channels</label>
              <div className="flex flex-wrap gap-2">
                {CHANNELS.map((ch) => (
                  <button
                    key={ch}
                    onClick={() => {
                      const channels = form.channels.includes(ch)
                        ? form.channels.filter((c) => c !== ch)
                        : [...form.channels, ch];
                      update("channels", channels);
                    }}
                    className={`px-3 py-1.5 text-xs border transition-colors ${
                      form.channels.includes(ch)
                        ? "border-accent text-accent bg-surface"
                        : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {ch}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">Review & Deploy</h2>
            <p className="text-sm text-muted mb-6">
              Confirm your TALOS configuration before deployment.
            </p>
            <div className="space-y-4 text-sm">
              <ReviewRow label="Product" value={form.productName} />
              <ReviewRow label="Category" value={form.category} />
              <ReviewRow label="Token" value={`${form.tokenName} (${form.tokenSymbol})`} />
              <ReviewRow label="Supply" value={Number(form.totalSupply).toLocaleString()} />
              <ReviewRow label="Price" value={`$${form.initialPrice}`} />
              <ReviewRow label="Agent Identity" value={`${form.agentName}.talos`} />
              <ReviewRow label="Revenue Model" value="100% Agent Treasury (no external distribution)" />
              <ReviewRow label="Creator (Stellar)" value={form.creatorWallet || address || ""} />
              <ReviewRow label="Approval" value={`> $${form.approvalThreshold}`} />
              <ReviewRow label="Budget" value={`$${form.gtmBudget}/mo`} />
              <ReviewRow label="Persona" value={form.persona} />
              <ReviewRow label="Audience" value={form.targetAudience} />
              <ReviewRow label="Channels" value={form.channels.join(", ")} />
              {form.serviceName && (
                <>
                  <ReviewRow label="Service" value={form.serviceName} />
                  <ReviewRow label="Service Price" value={form.servicePrice ? `${form.servicePrice} USDC` : "—"} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {submitting && (
        <div className="mb-6 border border-accent/30 bg-surface p-6">
          <div className="flex items-center gap-3 mb-4">
            <svg className="animate-spin h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-accent">{deployStep || "Preparing..."}</span>
          </div>
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-1 flex-1 transition-colors duration-300 ${
                  s <= deployProgress ? "bg-accent" : "bg-border"
                }`}
              />
            ))}
          </div>
          <div className="flex justify-between mt-1 text-xs text-muted">
            <span>Wallet</span>
            <span>Registry</span>
            <span>Name</span>
            <span>Database</span>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6 border border-red-600 bg-red-100/50 px-4 py-3 text-sm text-red-700 font-medium">
          {error}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <button
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
          className="px-6 py-2.5 text-sm border border-border text-foreground hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default"
        >
          Back
        </button>
        {step < 5 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={!canNext()}
            className="px-6 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleLaunch}
            disabled={submitting}
            className="px-8 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors disabled:opacity-50"
          >
            {submitting ? (deployStep || "Deploying...") : "Launch TALOS"}
          </button>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder = "",
  type = "text",
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
}) {
  const cls =
    "w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent";
  return (
    <div>
      <label className="block text-xs text-muted mb-2">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${cls} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={cls}
        />
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-border">
      <span className="text-muted">{label}</span>
      <span className="text-foreground text-right max-w-[60%] break-all">{value || "—"}</span>
    </div>
  );
}
