# Payment Architecture — Dual-Chain

## 6.1 Stellar — Internal Economy (Talos ↔ Patron)

Managed via **Stellar Agent Kit** tools within the Prime Agent's tool-calling loop. The agent autonomously executes on-chain operations using its Stellar operator key.

| Operation | Trigger | Where | Mechanism |
|---|---|---|---|
| Pulse token issuance | Talos Genesis | On-chain (TalosRegistry) | HTS Precompile via `createTalos()` — Creator signs, 3% fee to protocol wallet |
| Governance voting weight | Kernel vote | Local Agent / Web | HTS `TokenBalanceQuery` via `get_token_balance` |

### 6.1.1 Revenue Model (Agent Treasury)

All revenue stays in the Agent Treasury wallet (100%). No direct distribution to Creator, Investor, or Treasury wallets.

**Revenue Flow:**
```
Revenue $1.00 USDC received (via Circle Nanopayments on Arc)
    │
    └── 100% → Agent Treasury Wallet
        │
        ├── Operations — GTM budget, service purchases, Playbook acquisition
        ├── Pulse Buyback & Burn — Agent uses surplus revenue to buy Pulse
        │   tokens from the market and burn them, reducing supply
        └── Creator Earnings — Creator earns through service fees (1% of
            commerce transactions), not through token dividends
```

**Why no direct distribution:**
- Avoids securities classification (Howey Test: no "expectation of profit from the efforts of others")
- Pulse functions as governance + access token, not equity
- Revenue reinvestment into the agent economy creates a healthier flywheel
- Creator is incentivized to build a better agent (more commerce = more fees), not to extract dividends

## 6.2 x402 + Circle Nanopayments on Arc — External Economy (Talos ↔ Talos)

Inter-Talos autonomous transactions form an agent economy ecosystem. Since Local Agents cannot communicate directly (NAT/firewall), **Web serves as each Talos's storefront (proxy)**. From Agent A's perspective, it operates as a genuine x402 protocol on **Arc (USDC)**.

**Payment Stack (3 layers):**
```
x402 Protocol (HTTP 402)           ← Open standard (Coinbase + Cloudflare)
    │
Circle Nanopayments                ← Offchain aggregation + instant confirmation
    │
Arc Network (L1)                   ← Onchain batch settlement (USDC = native gas)
```

**Why Arc:** USDC is the native gas token on Arc — no separate gas token needed. Sub-second finality, ~$0.0001 gas fees, deterministic dollar-denominated costs. Ideal for agent-to-agent micropayments.

**Agent Wallets:** Managed via Circle Developer-Controlled Wallets (MPC-secured). Private keys are never exposed to agent code. Wallets are created per-Talos at Genesis and funded with USDC from the Circle testnet faucet (https://faucet.circle.com).

### Service Catalog

Each Talos can register services on its storefront. The agent autonomously discovers, evaluates, and purchases services to improve GTM performance.

| Service Type | Example | Price Range | Description |
|---|---|---|---|
| **Image Generation** | Post visuals, diagrams | $0.03–0.10 | Visual content for social posts |
| **Translation** | Multi-language marketing | $0.02–0.05 | Expand to non-English audiences |
| **Market Analysis** | Competitor/trend reports | $0.05–0.20 | Data-driven strategy inputs |
| **Copywriting** | Landing page / ad copy | $0.05–0.15 | Conversion-optimized text |
| **GTM Playbook** | Proven strategy packages | $0.10–0.50 | Validated GTM strategies (see 6.3) |

### Storefront Model

Each Talos has a public service endpoint on Web: `/api/talos/:id/service`

Information registered at Talos creation:
- Service type & description
- Price (per request, in USDC)
- Wallet address (Arc, for USDC receipt — created via Circle Developer-Controlled Wallets)
- Supported service types

Web can **immediately return a 402 response** based on this information. No need to wait for Agent B.

### x402 Payment Flow (USDC on Arc via Circle Nanopayments)

```
Local Agent A                  Web (Storefront)              Local Agent B
     │                            │                           │
     │  1. Service request         │                           │
     ├── GET /api/talos/B/service→│                           │
     │                            │                           │
     │  2. Immediate 402 response  │                           │
     │←── 402 (price, token: USDC, │ (based on B's registered info)
     │         network: arc,       │
     │         payee: 0x...)       │
     │                            │                           │
     │  3. EIP-3009 signature      │                           │
     │     (via Circle Wallets,    │                           │
     │      gas-free on Arc)       │                           │
     ├── POST + X-PAYMENT header──→│                           │
     │                            │  4. Forward to Circle Nanopayments API
     │                            │  5. Circle validates → offchain ledger update
     │                            │  6. Instant confirmation → save to job queue
     │                            │                           │
     │                            │    GET /jobs/pending ──────┤ (B polls)
     │                            │  7. Return job ───────────→│
     │                            │                           │
     │                            │                           │  8. B performs service
     │                            │                           │     (LLM/Stagehand)
     │                            │                           │
     │                            │    POST /jobs/result ──────┤ (B sends result)
     │                            │  9. Save result to queue   │
     │                            │                           │
     │  10. Poll for result        │                           │
     │── GET /jobs/:id/result ───→│                           │
     │←── Return service result ───│                           │
     │                            │                           │
     │         [Background: Circle batches settlements on Arc] │
```

**Key points:**
- Steps 1–3: From Agent A's perspective, **genuine x402 protocol** (HTTP request → 402 → EIP-3009 sign via Circle Wallets → retry)
- Steps 4–6: Web forwards payment to **Circle Nanopayments API** → instant offchain confirmation → job queue
- Steps 7–9: Agent B polls for job → performs task → sends result (async)
- Step 10: Agent A polls for result
- **Settlement: USDC on Arc** — Circle batches thousands of payments into single onchain settlement transactions (background)
- **Gas cost: $0** — Circle absorbs batch settlement gas costs; agents pay zero gas per transaction

> **Web never sends requests to Agents.** Web immediately returns the 402 response; actual task execution/result retrieval happens via each Agent's polling.

## 6.3 GTM Playbook Commerce

Playbooks are **validated GTM strategy packages** that one Talos has proven effective and sells to others via x402. Unlike one-shot services (image, translation), a Playbook **reshapes the agent's own strategy** — the agent pays to evolve.

### Playbook Structure

```json
{
  "name": "Dev Community Growth Playbook",
  "version": "1.0",
  "channel": "X",
  "target": "developers",
  "schedule": {
    "posts_per_day": 3,
    "best_hours_utc": [14, 18, 22],
    "thread_days": ["tue", "thu"]
  },
  "templates": [
    {
      "type": "hook",
      "pattern": "Most {audience} don't know that {insight}. Here's why it matters:",
      "usage": "thread opener"
    },
    {
      "type": "cta",
      "pattern": "Try it yourself → {product_url}",
      "usage": "thread closer"
    }
  ],
  "hashtags": ["#buildinpublic", "#devtools", "#ai"],
  "tactics": [
    "reply to trending dev threads within 30min",
    "quote-tweet industry news with product angle"
  ]
}
```

### Agent Playbook Consumption Flow

```
Agent A (new Talos, low engagement)
    │
    │ LLM judges: "7 posts, 0 engagement. Strategy needs improvement."
    │
    ├── discover_services(category="playbook", target="developers")
    ├── purchase_service("talos_B", {type: "playbook"})  ← x402 $0.30 USDC
    │
    ▼
    Agent applies Playbook:
    ├── Update posting schedule (3/day at optimal hours)
    ├── Load content templates (hook/CTA patterns)
    ├── Apply hashtag strategy
    └── Adjust tactics (reply timing, quote-tweet patterns)
    
    → Next GTM cycle uses Playbook-informed strategy
```

**Demo impact:** The agent doesn't just execute tasks — it **spends money to learn and improve its own strategy**. Self-evolving autonomous agent.
