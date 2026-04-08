# Architecture

## 4.1 Operating Model — Web + Local Agent (Dual-Chain)

The server (Vercel) handles only UI/API/relay, while the Prime Agent runs on the user's local PC. By using the local browser directly, bot detection, session, and 2FA friction is eliminated.

**Dual-Chain Design:** Stellar handles the internal token economy (Pulse, governance), while x402 + Circle Nanopayments on Arc handles inter-Talos service commerce (USDC nanopayments). All revenue stays in the Agent Treasury. No overlap — different chains, different tokens, different purposes.

```
┌───────────────────────────────────────────────────────┐
│  Talos Web (Vercel)                                  │
│  ─────────────────                                    │
│  Next.js 16 · React 19 · Tailwind CSS 4               │
│  Dashboard · Launchpad · Agents · Playbooks · Activity  │
│  REST API · Commerce Storefront (x402)                 │
│  Supabase (PostgreSQL)                                │
└──────────────────────┬────────────────────────────────┘
                       │ REST API (polling/reporting)
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
┌─────────────┐┌─────────────┐┌─────────────┐
│ Local Agent ││ Local Agent ││ Local Agent │
│ (User A)    ││ (User B)    ││ (User C)    │
│             ││             ││             │
│ Tool-calling││ Tool-calling││ Tool-calling│
│ Agent Loop  ││ Agent Loop  ││ Agent Loop  │
│ Stagehand   ││ Stagehand   ││ Stagehand   │
│ Local Chrome││ Local Chrome││ Local Chrome│
│ Stellar Kit  ││ Stellar Kit  ││ Stellar Kit  │
│ Circle+x402 ││ Circle+x402 ││ Circle+x402 │
└─────────────┘└─────────────┘└─────────────┘
          │                          │
┌─────────┴──────────┐  ┌───────────┴───────────────────┐
│ Stellar Network     │  │ Arc Network (EVM L1)           │
│ Pulse Token (HTS)  │  │ Circle Nanopayments + x402     │
│ Governance         │  │ Inter-Talos Commerce (USDC)   │
│                    │  │ Agent Treasury (USDC)           │
└────────────────────┘  └────────────────────────────────┘
```

| Layer | Platform | Responsibility |
|---|---|---|
| **Talos Web** | Vercel | UI, API, Talos registration, Pulse issuance, Commerce Storefront |
| **Database** | Supabase | Talos metadata, activity logs, revenue records, commerce queue |
| **Local Agent** | User PC | Prime Agent execution, GTM (local browser), Stellar Agent Kit, Circle Wallets + x402 signing |
| **Stellar** | Decentralized | Pulse token (HTS), governance (internal economy) |
| **Arc (EVM L1)** | Decentralized | Circle Nanopayments + x402, inter-Talos commerce (USDC), Agent Treasury management |

## 4.2 Dual-Chain Payment Architecture

| Dimension | Stellar (Internal Economy) | x402 + Circle Nanopayments on Arc (External Economy) |
|---|---|---|
| **Analogy** | Corporate governance cap table | B2B vendor procurement + agent treasury |
| **Scope** | Talos ↔ Patron (governance participants) | Talos ↔ Talos (trading partners) |
| **Token** | Pulse (HTS) | USDC (native on Arc) |
| **Chain** | Stellar | Arc (Circle's stablecoin-native EVM L1) |
| **SDK** | `stellar-agent-kit` (Python) | `x402` + `@creit-tech/stellar-wallets-kit` + Stellar Nanopayments API |
| **Use cases** | Pulse issuance, governance voting | Service purchases, Playbook trading, gas-free nanopayments, Agent Treasury management |
| **Prize track** | Stellar — AI & Agentic Payments ($6K) + Tokenization ($2.5K) | ARC — Agentic Nanopayments ($6K) |

**Stellar Agent Kit** provides 40+ on-chain tools (originally LangChain-compatible; we extract the schemas for native OpenAI function-calling). The Prime Agent uses a subset of these tools selectively based on operational needs (e.g., `get_token_balance` for governance weight). No LangChain runtime required.

**Circle Nanopayments** enables gas-free USDC transfers as small as $0.000001 via offchain aggregation. Individual payments are signed with EIP-3009, validated by Circle's Nanopayments API, and settled in batches on Arc. Agent wallets are managed via Circle Developer-Controlled Wallets (MPC-secured, private keys never exposed to agent code).

**Execution modes:**
- `AUTONOMOUS` — transactions below Kernel approval threshold are executed directly
- `RETURN_BYTES` — transactions above threshold return unsigned bytes → user approves on Dashboard → agent submits

## 4.3 Why Local Execution

| Problem | Server Execution | Local Execution |
|---|---|---|
| Bot Detection | Server IP → risk of blocking | User IP → normal traffic |
| Cookies/Session | Injection required (httpOnly inaccessible) | User browser → already logged in |
| 2FA | Cannot bypass | Not needed |
| Remote Browser Cost | $29–99/mo (Browserbase, etc.) | $0 |
| Fingerprint | Fake → detectable | Real → normal |
| Infrastructure Cost | Railway $5–20/mo/agent | $0 |

## 4.4 Core Components

| Component | Location | Role | Technology |
|---|---|---|---|
| Talos Genesis Engine | Web (on-chain) | Talos registration + Pulse token issuance via TalosRegistry contract (Creator signs, HTS precompile mints token, 3% launchpad fee to protocol wallet) | Next.js, Solidity, HTS Precompile |
| Patron Registry | Web | Governance participant management, voting weight | Drizzle, Supabase, HTS |
| Kernel Policy Engine | Web | Approval thresholds, GTM budget limits, operational policies | Config API |
| Commerce Storefront | Web | Per-Talos x402 service endpoint + job queue | Next.js API Routes, Supabase |
| Prime Agent Runtime | Local | Autonomous GTM execution via tool-calling agent loop | OpenAI SDK, Stagehand, Stellar Agent Kit |
| Inter-Talos Commerce | Local + Web | x402 signing on Arc (Local via Circle Wallets) + Storefront/job queue (Web) | x402, Circle Nanopayments, Circle Developer-Controlled Wallets |
| Internal Economy | Local + Web | Pulse token ops, governance | Stellar Agent Kit |
