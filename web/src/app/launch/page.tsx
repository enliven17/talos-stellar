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
import { OPERATOR_PUBLIC_KEY } from "@/lib/stellar-config";
import { TALOS_NAME_MIN_LENGTH, TALOS_NAME_MAX_LENGTH } from "@/lib/limits";
import {
  type LaunchFormState,
  LAUNCH_FORM_DEFAULTS,
  buildCreateTalosPayload,
} from "@/lib/schemas";
import {
  StepProduct,
  StepPatron,
  StepMitos,
  StepKernel,
  StepAgent,
  StepReview,
  LaunchStepper,
  Field,
  ReviewRow,
} from "./steps";

const STEPS: StepConfig[] = [
  { id: "product", key: "launch.steps.product" },
  { id: "patron", key: "launch.steps.patron" },
  { id: "mitos", key: "launch.steps.mitos" },
  { id: "kernel", key: "launch.steps.kernel" },
  { id: "agent", key: "launch.steps.agent" },
  { id: "review", key: "launch.steps.review" },
];

const CHANNELS = ["X (Twitter)", "LinkedIn", "Reddit", "Product Hunt"];

export default function LaunchPage() {
  const { t } = useTranslation();

  return (
    <WalletGate
      title={t("launch.walletGate.title")}
      description={t("launch.walletGate.description")}
    >
      <LaunchForm />
    </WalletGate>
  );
}

function LaunchForm() {
  const { t } = useTranslation();
  const { address } = useWallet();
  const { signTransaction } = useStellarWallet();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<LaunchFormState>(LAUNCH_FORM_DEFAULTS);
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

  const update = useCallback(
    (key: keyof LaunchFormState, value: string | string[]) =>
      setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkNameAvailability = useCallback((name: string) => {
    if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    if (!name || name.length < TALOS_NAME_MIN_LENGTH) {
      setNameAvailable(null);
      setNameChecking(false);
      return;
    }
    if (name.length > TALOS_NAME_MAX_LENGTH) {
      setNameAvailable(false);
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
        const valid =
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && !/--/.test(name);
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
          && form.agentName.length >= TALOS_NAME_MIN_LENGTH
          && form.agentName.length <= TALOS_NAME_MAX_LENGTH
          && nameAvailable === true;
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
      setDeployStep(t("launch.verifyingWallet"));
      setDeployProgress(1);
      await ensureStellarNetwork(address);

      const creatorAddr = form.creatorWallet || address;

      // 2. Register TALOS on-chain via Soroban (if contract is deployed)
      if (TALOS_REGISTRY_CONTRACT_ID) {
        setDeployStep(t("launch.registeringSoroban"));
        setDeployProgress(2);

        const {
          TransactionBuilder,
          BASE_FEE,
          Account,
          Contract,
          nativeToScVal,
          scValToNative,
          rpc,
          xdr,
        } = await import("@stellar/stellar-sdk");
        const network = getNetwork();
        const server = new rpc.Server(network.sorobanRpc);
        const account = await server.getAccount(address);

        const registry = new Contract(TALOS_REGISTRY_CONTRACT_ID);
        const categoryCapitalized =
          form.category.charAt(0).toUpperCase() + form.category.slice(1);

        const OPERATOR = OPERATOR_PUBLIC_KEY;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scEntry = (key: string, val: any) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

        const scI128 = (n: number) =>
          nativeToScVal(BigInt(Math.round(n)), { type: "i128" });

        const patronVal = xdr.ScVal.scvMap([
          scEntry(
            "creator_addr",
            nativeToScVal(creatorAddr, { type: "address" }),
          ),
          scEntry("creator_share", xdr.ScVal.scvU32(60)),
          scEntry(
            "investor_addr",
            nativeToScVal(creatorAddr, { type: "address" }),
          ),
          scEntry("investor_share", xdr.ScVal.scvU32(25)),
          scEntry(
            "treasury_addr",
            nativeToScVal(OPERATOR, { type: "address" }),
          ),
          scEntry("treasury_share", xdr.ScVal.scvU32(15)),
        ]);

        const kernelVal = xdr.ScVal.scvMap([
          scEntry(
            "approval_threshold",
            scI128(Number(form.approvalThreshold) || 10),
          ),
          scEntry("gtm_budget", scI128(Number(form.gtmBudget) || 100)),
          scEntry("min_patron_pulse", scI128(100)),
        ]);

        const pulseVal = xdr.ScVal.scvMap([
          scEntry(
            "price_usd_cents",
            scI128(
              Math.round(parseFloat(form.initialPrice || "0.01") * 100),
            ),
          ),
          scEntry(
            "token_symbol",
            nativeToScVal(form.tokenSymbol.toUpperCase(), { type: "string" }),
          ),
          scEntry(
            "total_supply",
            scI128(Number(form.totalSupply) || 1_000_000),
          ),
        ]);

        const tx = new TransactionBuilder(
          new Account(account.accountId(), account.sequenceNumber()),
          { fee: BASE_FEE, networkPassphrase: network.networkPassphrase },
        )
          .addOperation(
            registry.call(
              "create_talos",
              nativeToScVal(form.productName, { type: "string" }),
              nativeToScVal(categoryCapitalized, { type: "string" }),
              nativeToScVal(form.persona || form.productDesc, {
                type: "string",
              }),
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
        const result = await server.sendTransaction(
          TB.fromXDR(signedXdr, network.networkPassphrase),
        );

        if (result.status === "ERROR")
          throw new Error("Soroban transaction failed");

        let getResult = await server.getTransaction(result.hash);
        for (
          let i = 0;
          i < 10 && getResult.status === "NOT_FOUND";
          i++
        ) {
          await new Promise((r) => setTimeout(r, 2000));
          getResult = await server.getTransaction(result.hash);
        }
        if (getResult.status === "SUCCESS" && getResult.returnValue) {
          const raw = scValToNative(getResult.returnValue);
          onChainId =
            typeof raw === "bigint" ? Number(raw) : (raw as number);
        }
      } else {
        setDeployProgress(2);
      }

      // 3. Register agent name on-chain (if name service is deployed)
      if (TALOS_NAME_SERVICE_CONTRACT_ID && onChainId !== null) {
        setDeployStep(t("launch.registeringIdentity"));
        setDeployProgress(3);

        const {
          TransactionBuilder,
          BASE_FEE,
          Account,
          Contract,
          nativeToScVal,
          rpc,
        } = await import("@stellar/stellar-sdk");
        const network = getNetwork();
        const server = new rpc.Server(network.sorobanRpc);
        const account = await server.getAccount(address);

        const nameService = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
        const tx = new TransactionBuilder(
          new Account(account.accountId(), account.sequenceNumber()),
          { fee: BASE_FEE, networkPassphrase: network.networkPassphrase },
        )
          .addOperation(
            nameService.call(
              "register_name",
              nativeToScVal(creatorAddr, { type: "address" }),
              nativeToScVal(onChainId, { type: "u32" }),
              nativeToScVal(form.agentName.toLowerCase().trim(), {
                type: "string",
              }),
            ),
          )
          .setTimeout(60)
          .build();

        const preparedTx = await server.prepareTransaction(tx);
        const signedXdr = await signTransaction(preparedTx.toXDR());
        const result = await server.sendTransaction(
          TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase),
        );
        if (result.status === "ERROR")
          throw new Error("Name registration failed");

        let getResult = await server.getTransaction(result.hash);
        for (
          let i = 0;
          i < 10 && getResult.status === "NOT_FOUND";
          i++
        ) {
          await new Promise((r) => setTimeout(r, 2000));
          getResult = await server.getTransaction(result.hash);
        }
      } else {
        setDeployProgress(3);
      }

      // 4. Save to database
      setDeployStep(t("launch.savingDatabase"));
      setDeployProgress(4);

      let dbData: { id: string; apiKeyOnce: string } | null = null;
      try {
        const res = await fetch("/api/talos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildCreateTalosPayload(form, address, onChainId),
          ),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Failed to save TALOS");
        }
        dbData = await res.json();
      } catch (dbErr) {
        const msg =
          dbErr instanceof Error ? dbErr.message : "Database save failed";
        const onChainInfo =
          onChainId !== null
            ? `On-chain registration succeeded (ID: ${onChainId}, Agent: ${form.agentName}.talos) but database save failed: ${msg}. `
            : `Database save failed: ${msg}. `;
        setError(
          onChainInfo + "Please contact support to recover.",
        );
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
        message = t("launch.txRejected");
      else if (raw.includes("Account not found"))
        message = raw;
      else if (raw.includes("insufficient") || raw.includes("balance"))
        message = t("launch.insufficientBalance");
      else if (raw.length > 200)
        message = t("launch.deployFailed");
      setError(message);
    } finally {
      setSubmitting(false);
      setDeployStep(null);
      setDeployProgress(0);
    }
  };

  // ── Genesis success screen ────────────────────────────────────────────────
  if (genesisResult) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <div className="text-xs text-accent font-bold mb-2">{t("launch.genesis.badge")}</div>
          <h1 className="text-2xl font-bold text-accent">{t("launch.genesis.title")}</h1>
        </div>

        <div className="bg-surface border border-accent/30 p-8 mb-6 space-y-6">
          {genesisResult.onChainId !== null && (
            <div className="flex items-center gap-3 text-accent font-bold">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              <span className="text-sm font-medium">
                {t("launch.genesis.onChainConfirmed", { id: genesisResult.onChainId })}
              </span>
            </div>
          )}

          <div>
            <div className="text-xs text-muted mb-2">{t("launch.genesis.agentIdentity")}</div>
            <div data-testid="launched-agent-identity" className="text-foreground font-mono text-sm">{genesisResult.agentName}.talos</div>
          </div>

          <div>
            <div className="text-xs text-accent font-bold mb-2">{t("launch.genesis.apiKeyTitle")}</div>
            <div data-testid="launched-api-key" className="bg-background border border-border p-3 font-mono text-xs text-accent break-all select-all">
              {genesisResult.apiKey}
            </div>
          </div>

          <div>
            <div className="text-xs text-muted mb-4">{t("launch.genesis.runAgent")}</div>
            <div className="bg-background border border-border p-4 text-xs text-foreground space-y-1 overflow-x-auto">
              <div className="text-muted">{t("launch.genesis.stepInstall")}</div>
              <div>pip install talos-agent</div>
              <div className="text-muted mt-3">{t("launch.genesis.stepKey")}</div>
              <div>export TALOS_API_KEY=&quot;{genesisResult.apiKey}&quot;</div>
              <div className="text-muted mt-3">{t("launch.genesis.stepStart")}</div>
              <div>talos-agent start --talos-id {genesisResult.talosId}</div>
            </div>
          </div>
        </div>

        <div className="flex justify-between">
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(genesisResult.apiKey)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
            }}
            data-testid="copy-api-key-button"
            className={`px-6 py-2.5 text-sm border transition-colors ${
              copied
                ? "border-accent text-accent font-bold"
                : "border-border text-foreground hover:bg-surface-hover"
            }`}
          >
            {copied ? t("launch.genesis.copied") : t("launch.genesis.copyApiKey")}
          </button>
          <button
            onClick={() =>
              router.push(`/agents/${genesisResult.talosId}`)
            }
            data-testid="view-launched-talos-button"
            className="px-8 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors"
          >
            {t("launch.genesis.viewTalos")}
          </button>
        </div>
      </div>
    );
  }

  // ── Demo prefill ─────────────────────────────────────────────────────────
  const loadDemo = () => {
    setForm({
      productName: "Nexus",
      productDesc:
        "AI-powered payment agent that automates invoicing, subscription billing, and cross-border settlements. Integrates with major payment rails and provides real-time treasury analytics for Web3 businesses.",
      category: "finance",
      tokenName: "Nexus Mitos",
      tokenSymbol: "NEXUS",
      totalSupply: "1000000",
      initialPrice: "0.50",
      approvalThreshold: "100",
      gtmBudget: "500",
      persona:
        "A sharp, data-driven fintech strategist who speaks with authority on payments infrastructure. Combines deep technical knowledge with clear, actionable insights. Always backs claims with numbers.",
      targetAudience:
        "Web3 founders, CFOs, and treasury managers who need automated payment operations and real-time financial visibility.",
      tone: "professional",
      creatorWallet: "",
      channels: ["X (Twitter)", "LinkedIn"],
      agentName: "nexus",
      serviceName: "Payment Automation",
      serviceDescription:
        "Automates invoice generation, payment routing, and settlement reconciliation. Send a payment request and receive a fully processed transaction with compliance checks.",
      servicePrice: "2.50",
      serviceCurrency: "USDC",
    });
    checkNameAvailability("nexus");
    setStep(0);
  };

  // ── Step content map ─────────────────────────────────────────────────────
  const stepContent = [
    <StepProduct key="product" form={form} update={update} />,
    <StepPatron key="patron" form={form} address={address ?? undefined} />,
    <StepMitos key="mitos" form={form} update={update} />,
    <StepKernel key="kernel" form={form} update={update} />,
    <StepAgent
      key="agent"
      form={form}
      update={update}
      nameAvailable={nameAvailable}
      nameChecking={nameChecking}
      checkNameAvailability={checkNameAvailability}
    />,
    <StepReview key="review" form={form} address={address ?? undefined} />,
  ];

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="mb-8 flex items-end justify-between">
        <div>
          <div className="text-xs text-muted mb-2">{t("launch.badge")}</div>
          <h1 className="text-2xl font-bold text-accent">{t("launch.title")}</h1>
        </div>
        <button
          onClick={loadDemo}
          data-testid="load-demo-launch-form-button"
          className="px-4 py-2 text-xs border border-accent/30 text-accent hover:bg-surface-hover transition-colors"
        >
          {t("launch.demoButton")}
        </button>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-10 overflow-x-auto">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => i <= step && setStep(i)}
            data-testid={`launch-step-${s.id}`}
            className={`px-3 py-1.5 text-xs border transition-colors whitespace-nowrap ${
              i === step
                ? "border-accent text-accent bg-surface"
                : i < step
                ? "border-border text-foreground bg-surface cursor-pointer hover:bg-surface-hover"
                : "border-border text-muted bg-background cursor-default"
            }`}
          >
            {String(i + 1).padStart(2, "0")} {t(s.key)}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="bg-surface border border-border p-8 mb-6">
        {step === 0 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.product.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.product.description")}
            </p>
            <Field
              label={t("launch.product.name")}
              testId="launch-input-product-name"
              value={form.productName}
              onChange={(v) => update("productName", v)}
              placeholder={t("launch.product.namePlaceholder")}
            />
            <Field
              label={t("launch.product.desc")}
              testId="launch-input-description"
              value={form.productDesc}
              onChange={(v) => update("productDesc", v)}
              placeholder={t("launch.product.descPlaceholder")}
              multiline
            />
            <div>
              <label className="block text-xs text-muted mb-2">{t("launch.product.category")}</label>
              <select
                value={form.category}
                onChange={(e) => update("category", e.target.value)}
                data-testid="launch-input-category"
                className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
              >
                <option value="marketing">{t("launch.categories.marketing")}</option>
                <option value="development">{t("launch.categories.development")}</option>
                <option value="research">{t("launch.categories.research")}</option>
                <option value="design">{t("launch.categories.design")}</option>
                <option value="finance">{t("launch.categories.finance")}</option>
                <option value="analytics">{t("launch.categories.analytics")}</option>
                <option value="operations">{t("launch.categories.operations")}</option>
                <option value="sales">{t("launch.categories.sales")}</option>
                <option value="support">{t("launch.categories.support")}</option>
                <option value="education">{t("launch.categories.education")}</option>
              </select>
            </div>

            <div className="pt-4 mt-2 border-t border-border">
              <div className="text-xs text-accent mb-1">{t("launch.product.commerceBadge")}</div>
              <p className="text-xs text-muted mb-4">
                {t("launch.product.commerceDesc")}
              </p>
              <div className="space-y-4">
                <Field
                  label={t("launch.product.serviceName")}
                  testId="launch-input-service-name"
                  value={form.serviceName}
                  onChange={(v) => update("serviceName", v)}
                  placeholder={t("launch.product.serviceNamePlaceholder")}
                />
                <Field
                  label={t("launch.product.serviceDesc")}
                  testId="launch-input-service-description"
                  value={form.serviceDescription}
                  onChange={(v) => update("serviceDescription", v)}
                  placeholder={t("launch.product.serviceDescPlaceholder")}
                  multiline
                />
                <div>
                  <label className="block text-xs text-muted mb-2">{t("launch.product.servicePrice")}</label>
                  <input
                    type="number"
                    value={form.servicePrice}
                    onChange={(e) => update("servicePrice", e.target.value)}
                    placeholder={t("launch.product.servicePricePlaceholder")}
                    data-testid="launch-input-service-price"
                    className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.patron.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.patron.description")}
            </p>
            <div>
              <label className="block text-xs text-muted mb-2">{t("launch.patron.creatorLabel")}</label>
              <div
                data-testid="creator-wallet-display"
                className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground/70 font-mono select-all break-all"
              >
                {form.creatorWallet || address || "—"}
              </div>
              <p className="text-xs text-muted mt-1">{t("launch.patron.creatorHint")}</p>
            </div>
            <div className="p-4 border border-border bg-background">
              <div className="text-xs text-accent mb-2">{t("launch.patron.revenueModelBadge")}</div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted">{t("launch.patron.agentTreasury")}</span>
                  <span className="text-foreground font-medium">100%</span>
                </div>
              </div>
              <p className="text-xs text-muted mt-3">{t("launch.patron.treasuryHint")}</p>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.mitos.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.mitos.description")}
            </p>
            <Field
              label={t("launch.mitos.tokenName")}
              testId="launch-input-token-name"
              value={form.tokenName}
              onChange={(v) => update("tokenName", v)}
              placeholder={t("launch.mitos.tokenNamePlaceholder")}
            />
            <div>
              <Field
                label={t("launch.mitos.tokenSymbol")}
                testId="launch-input-token-symbol"
                value={form.tokenSymbol}
                onChange={(v) => update("tokenSymbol", v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                placeholder={t("launch.mitos.tokenSymbolPlaceholder")}
              />
              <p className="text-xs text-muted mt-1">{t("launch.mitos.tokenSymbolHint")}</p>
            </div>
            <div>
              <Field
                label={t("launch.mitos.totalSupply")}
                testId="launch-input-total-supply"
                value={form.totalSupply}
                onChange={(v) => update("totalSupply", v)}
                type="number"
              />
              <p className="text-xs text-muted mt-1">{t("launch.mitos.totalSupplyHint")}</p>
            </div>
            <div>
              <Field
                label={t("launch.mitos.initialPrice")}
                testId="launch-input-initial-price"
                value={form.initialPrice}
                onChange={(v) => update("initialPrice", v)}
                type="number"
              />
              <p className="text-xs text-muted mt-1">{t("launch.mitos.initialPriceHint")}</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.kernel.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.kernel.description")}
            </p>
            <Field
              label={t("launch.kernel.approvalThreshold")}
              testId="launch-input-approval-threshold"
              value={form.approvalThreshold}
              onChange={(v) => update("approvalThreshold", v)}
              type="number"
              placeholder={t("launch.kernel.approvalThresholdPlaceholder")}
            />
            <Field
              label={t("launch.kernel.gtmBudget")}
              testId="launch-input-gtm-budget"
              value={form.gtmBudget}
              onChange={(v) => update("gtmBudget", v)}
              type="number"
              placeholder={t("launch.kernel.gtmBudgetPlaceholder")}
            />
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.agent.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.agent.description")}
            </p>
            <div>
              <label className="block text-xs text-muted mb-2">{t("launch.agent.identityLabel")}</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={form.agentName}
                  onChange={(e) => {
                    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                    update("agentName", v);
                    checkNameAvailability(v);
                  }}
                  placeholder={t("launch.agent.identityPlaceholder")}
                  data-testid="launch-input-agent-identity"
                  className="flex-1 bg-background border border-border px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent"
                />
                <span className="text-sm text-muted">.talos</span>
              </div>
              <div className="mt-1.5 text-xs">
                {nameChecking && <span className="text-muted">{t("launch.agent.checking")}</span>}
                {!nameChecking && nameAvailable === true && form.agentName.length >= TALOS_NAME_MIN_LENGTH && (
                  <span className="text-accent font-bold">
                    {t("launch.agent.available", { name: form.agentName })}
                  </span>
                )}
                {!nameChecking && nameAvailable === false && form.agentName.length <= TALOS_NAME_MAX_LENGTH && (
                  <span className="text-red-600 font-bold">
                    {t("launch.agent.taken", { name: form.agentName })}
                  </span>
                )}
                {!nameChecking && form.agentName.length > TALOS_NAME_MAX_LENGTH && (
                  <span className="text-red-600 font-bold">
                    {t("launch.agent.maxChars", { max: TALOS_NAME_MAX_LENGTH })}
                  </span>
                )}
                {!nameChecking && nameAvailable === null && form.agentName.length > 0 && form.agentName.length < TALOS_NAME_MIN_LENGTH && (
                  <span className="text-muted">
                    {t("launch.agent.minChars", { min: TALOS_NAME_MIN_LENGTH })}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted mt-1">{t("launch.agent.identityHint")}</p>
            </div>
            <Field
              label={t("launch.agent.persona")}
              testId="launch-input-persona"
              value={form.persona}
              onChange={(v) => update("persona", v)}
              placeholder={t("launch.agent.personaPlaceholder")}
              multiline
            />
            <Field
              label={t("launch.agent.targetAudience")}
              testId="launch-input-target-audience"
              value={form.targetAudience}
              onChange={(v) => update("targetAudience", v)}
              placeholder={t("launch.agent.targetAudiencePlaceholder")}
            />
            <div>
              <label className="block text-xs text-muted mb-2">{t("launch.agent.tone")}</label>
              <select
                value={form.tone}
                onChange={(e) => update("tone", e.target.value)}
                data-testid="launch-input-tone"
                className="w-full bg-background border border-border px-4 py-2.5 text-sm text-foreground focus:outline-none focus:border-accent"
              >
                <option value="professional">{t("launch.agent.toneProfessional")}</option>
                <option value="casual">{t("launch.agent.toneCasual")}</option>
                <option value="witty">{t("launch.agent.toneWitty")}</option>
                <option value="technical">{t("launch.agent.toneTechnical")}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-muted mb-2">{t("launch.agent.channels")}</label>
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
                    data-testid={`launch-channel-${ch.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
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
            <h2 className="text-lg font-bold text-accent mb-1">{t("launch.review.title")}</h2>
            <p className="text-sm text-muted mb-6">
              {t("launch.review.description")}
            </p>
            <div className="space-y-4 text-sm">
              <ReviewRow label={t("launch.review.product")} value={form.productName} />
              <ReviewRow label={t("launch.review.category")} value={form.category} />
              <ReviewRow label={t("launch.review.token")} value={`${form.tokenName} (${form.tokenSymbol})`} />
              <ReviewRow label={t("launch.review.supply")} value={Number(form.totalSupply).toLocaleString()} />
              <ReviewRow label={t("launch.review.price")} value={`$${form.initialPrice}`} />
              <ReviewRow label={t("launch.review.agentIdentity")} value={`${form.agentName}.talos`} />
              <ReviewRow label={t("launch.review.revenueModel")} value={t("launch.review.revenueModelValue")} />
              <ReviewRow label={t("launch.review.creator")} value={form.creatorWallet || address || ""} />
              <ReviewRow label={t("launch.review.approval")} value={`> $${form.approvalThreshold}`} />
              <ReviewRow label={t("launch.review.budget")} value={`$${form.gtmBudget}/mo`} />
              <ReviewRow label={t("launch.review.persona")} value={form.persona} />
              <ReviewRow label={t("launch.review.audience")} value={form.targetAudience} />
              <ReviewRow label={t("launch.review.channels")} value={form.channels.join(", ")} />
              {form.serviceName && (
                <>
                  <ReviewRow label={t("launch.review.service")} value={form.serviceName} />
                  <ReviewRow label={t("launch.review.servicePrice")} value={form.servicePrice ? `${form.servicePrice} USDC` : "—"} />
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Deploy progress */}
      {submitting && (
        <div className="mb-6 border border-accent/30 bg-surface p-6">
          <div className="flex items-center gap-3 mb-4">
            <svg
              className="animate-spin h-4 w-4 text-accent"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-sm text-accent">{deployStep || t("launch.deploying.preparing")}</span>
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
            <span>{t("launch.deploying.wallet")}</span>
            <span>{t("launch.deploying.registry")}</span>
            <span>{t("launch.deploying.name")}</span>
            <span>{t("launch.deploying.database")}</span>
          </div>
        </div>
      )}

      {/* Error */}
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
          data-testid="launch-back-button"
          className="px-6 py-2.5 text-sm border border-border text-foreground hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default"
        >
          {t("launch.buttons.back")}
        </button>
        {step < 5 ? (
          <button
            onClick={() => setStep(step + 1)}
            disabled={!canNext()}
            data-testid="launch-next-button"
            className="px-6 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
          >
            {t("launch.buttons.next")}
          </button>
        ) : (
          <button
            onClick={handleLaunch}
            disabled={submitting}
            data-testid="launch-submit-button"
            className="px-8 py-2.5 text-sm bg-accent text-background font-medium hover:bg-foreground transition-colors disabled:opacity-50"
          >
            {submitting ? (deployStep || t("launch.deploying.deploying")) : t("launch.buttons.launch")}
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
  testId: customTestId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
  testId?: string;
}) {
  const testId = customTestId ?? `launch-input-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
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
          data-testid={testId}
          className={`${cls} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          data-testid={testId}
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
