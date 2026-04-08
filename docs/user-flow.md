# User Flow

## 5.1 Talos Genesis (Incorporation)

```
1. User inputs product/service description + token config
        │
        ▼
2. Talos Genesis executes (Creator signs on-chain tx)
   ├── TalosRegistry.createTalos() called
   │   ├── HTS Precompile mints Pulse token (contract = treasury)
   │   ├── 3% launchpad fee → Talos Protocol wallet
   │   └── 97% → Creator wallet
   ├── Revenue model: 100% Agent Treasury (no external distribution)
   │   - Creator earns through service fees
   │   - Pulse = governance + access token (no dividends)
   ├── Set Kernel policies
   │   - Approval threshold (e.g., transactions > $10 require approval)
   │   - GTM budget limits, operational parameters
   ├── TalosNameService.registerName() — immutable agent identity
   ├── Create Agent Wallet (Circle Developer-Controlled Wallet)
   │   - Web calls Circle SDK → MPC wallet created on Arc
   │   - walletId + address saved to Supabase
   │   - Testnet: auto-fund via Circle faucet (20 USDC)
   │   - Agent signs x402 payments via this wallet (private key never exposed)
   ├── Prime Agent configuration
   │   - Persona, target audience, tone & voice
   │   - GTM target channels (X, LinkedIn, Reddit, etc.)
   └── Talos creation complete + API key issued
        │
        ▼
3. User runs Prime Agent locally
   $ pip install talos-agent
   $ talos-agent start --talos-id 0.0.111
```

**Launchpad Fee:** 3% of total Pulse supply is sent to the Talos Protocol wallet on every Genesis as a platform fee. This is enforced on-chain in the TalosRegistry contract (`LAUNCHPAD_FEE_BPS = 300`).

## 5.1.1 Wallet Architecture

Talos Protocol uses two distinct wallet types for different purposes.

| Subject | Wallet Type | Created By | When | Purpose |
|---|---|---|---|---|
| **Creator** | User-owned (Dynamic: MetaMask, HashPack, etc.) | User connects manually | Launchpad entry | Stellar Pulse signing, Dashboard approvals |
| **Prime Agent** | Circle Developer-Controlled Wallet (MPC) | **Web backend, auto-created** | **Talos Genesis** | x402 payments, USDC receipt, Agent Treasury management |
| **Patron** | User-owned (Dynamic) | User connects manually | Agents page | Pulse purchase, governance participation |

**Why Circle MPC for Agent Wallets:**
- Private key never exists in one place — split across MPC nodes via Shamir's Secret Sharing
- Agent code calls Circle API to sign → Circle MPC nodes cooperate to produce signature → signed tx broadcast
- Agent can sign autonomously without human approval (default mode)
- No `PRIVATE_KEY` in .env — only `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET`

```
Agent code: "Send 0.05 USDC to 0xABC"
    │
    ▼
Circle API (POST /developer/transactions)
    │
    ▼
MPC Node A (key shard 1) + MPC Node B (key shard 2)
    │ cooperate to sign (key never reassembled)
    ▼
Signed transaction → broadcast to Arc
```

**1 Talos = 1 Agent Wallet** — each Talos has its own Circle wallet address for independent financial operations.

## 5.2 Pulse Trading & Patron Registration

Pulse and Patron are intentionally separated to balance open market access with governance integrity.

### Buy Pulse (Open Market)

Anyone with a connected wallet can buy/sell Pulse tokens freely. Pulse grants governance participation rights and service access. No direct USDC dividends — all revenue stays in the Agent Treasury.

### Become Patron (Governance Registration)

Patron status grants governance rights (Kernel voting, policy proposals) but requires a **minimum Pulse holding threshold**. This prevents spam governance while keeping token trading open.

**Minimum threshold:** `totalSupply × 0.1%` (configurable per Talos via Kernel policy, stored as `minPatronPulse`)

```
Wallet connected → Buy Pulse (free market)
                       ↓
               Holding ≥ minPatronPulse?
                  No → "Become Patron" disabled (tooltip: "Requires N or more Pulse")
                  Yes → "Become Patron" enabled
                       ↓
               Click → Patron registration (on-chain record)
                       ↓
               Governance rights activated
                       ↓
               Holding drops below threshold?
                  → Patron status auto-revoked
```

| Action | Condition | Rights |
|---|---|---|
| **Buy Pulse** | Wallet connected | Governance participation, service access |
| **Become Patron** | Pulse holding ≥ `minPatronPulse` | Governance voting + Kernel policy proposals |

## 5.3 GTM Autonomous Execution (Human-in-the-Loop)

The Prime Agent autonomously executes GTM on the user's local PC using Stagehand + local Chrome, with important decisions requiring user approval.

```
3. Prime Agent autonomous execution (local browser-based)
   │
   ├── Autonomous (Agent decides)
   │   ├── Target user/market research via Stagehand (local Chrome web browsing)
   │   ├── Content draft generation (LLM)
   │   ├── Posting & mention/reply handling on X/LinkedIn/Reddit via Stagehand
   │   ├── Routine posting schedule execution
   │   └── Small x402 transactions (below threshold)
   │
   └── Approval Required (User confirmation)
       ├── First posting tone & voice approval
       ├── Large Inter-Talos transactions
       ├── Kernel policy changes
       ├── New channel/strategy activation
       └── Spending above threshold
```

## 5.4 Approval Flow

```
Prime Agent makes decision
    │
    ├── Below threshold → Autonomous execution + report activity log via Web API
    │
    └── Above threshold → Request approval
        ├── Send approval request via Web API → Dashboard notification
        ├── Approved on Dashboard → Agent receives result via polling → Execute
        └── Rejected → Suggest alternative
```
