# Tech Stack

## 12.1 Overview

```
talos/
├── apps/
│   └── web/                     ← Next.js 16 (Vercel)
│       ├── Frontend (Dashboard, Launchpad, Agents, Playbooks, Activity, etc.)
│       ├── REST API
│       └── Commerce Storefront (x402)
│
├── contracts/                   ← Solidity (Stellar Testnet)
│   ├── TalosRegistry.sol       ← Talos genesis + Pulse token issuance
│   └── TalosNameService.sol    ← Domain naming
│
└── packages/
    └── prime-agent/             ← Python (User PC)
        ├── OpenAI Tool-Calling Agent Loop (Brain)
        ├── Stagehand + Local Chrome (Hands)
        └── x402 Signing (Payments)
```

```
┌─────────────────────────────────────────────────────────┐
│           Vercel — apps/web                              │
│  Next.js 16 · React 19 · Tailwind CSS 4                 │
│  Dashboard · Launchpad · Agents · Playbooks · Activity   │
│  Supabase (PostgreSQL) · @worldcoin/idkit                │
│  REST API · Commerce Storefront (x402)                   │
└────────────────────────┬────────────────────────────────┘
                         │ REST API
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ Local Agent│ │ Local Agent│ │ Local Agent│
   │ Python     │ │ Python     │ │ Python     │
   │ OpenAI SDK │ │ OpenAI SDK │ │ OpenAI SDK │
   │ Stagehand  │ │ Stagehand  │ │ Stagehand  │
   │ Chrome     │ │ Chrome     │ │ Chrome     │
   └────────────┘ └────────────┘ └────────────┘
```

| Component | Technology | Deployment | Cost |
|---|---|---|---|
| **Web** | Next.js 16 | Vercel | Free–Pro |
| **DB** | Supabase (PostgreSQL) | Supabase Cloud | Free–Pro |
| **Prime Agent** | Python | User PC (local execution) | $0 |

---

## 12.2 apps/web — Talos Web (Vercel)

Dashboard, Launchpad, Agents, Playbooks, Activity, Leaderboard. Frontend + REST API + Commerce Storefront.

### Frontend

| Package | Purpose | Notes |
|---|---|---|
| `next` 16 | App Router, SSR/SSG, API Routes | Full-stack framework |
| `react` 19 | UI rendering | Leverages Server Components |
| `tailwindcss` 4 | Styling | Utility-first |
| `@worldcoin/idkit` | World ID widget | Patron uniqueness verification |
| `@dynamic-labs/sdk-react-core` | Dynamic wallet SDK | Multi-wallet connection (HashPack, MetaMask, WalletConnect) |
| `@dynamic-labs/wallet-connect` | WalletConnect connector | WalletConnect protocol support |
| `recharts` | Pulse charts, revenue graphs | Dashboard/Leaderboard |
| `framer-motion` | Animations | Launchpad step transitions |
| `@circle-fin/developer-controlled-wallets` | Circle Wallets SDK | Agent wallet creation, Nanopayments integration |
| `openai` | OpenAI SDK | AI-powered service fulfillment (server-side) |
| `@paralleldrive/cuid2` | CUID2 generator | Unique ID generation for entities |
| `lucide-react` | Icon library | UI icons |

### Backend / Database

| Package | Purpose | Notes |
|---|---|---|
| Next.js API Routes | REST API | Called by Local Agent + Frontend |
| `drizzle-orm` + `pg` | ORM + PostgreSQL driver | Type-safe queries, direct connection to Supabase PostgreSQL |
| `drizzle-kit` | Migration tool | Schema push, migration generation |
| `zod` | Input validation | API request schemas |

### Web API Endpoints

| Endpoint | Method | Caller | Purpose |
|---|---|---|---|
| `/api/talos` | GET | Web UI | List all Taloses |
| `/api/talos` | POST | Web UI | Talos registration (Genesis) |
| `/api/talos/me` | GET | Web UI | Get Taloses owned by current wallet |
| `/api/talos/:id` | GET | Web UI / Local Agent | Talos detail + configuration |
| `/api/talos/:id/activity` | GET | Web UI | Activity log for Talos |
| `/api/talos/:id/activity` | POST | Local Agent | Agent activity reporting |
| `/api/talos/:id/revenue` | GET | Web UI | Revenue history for Talos |
| `/api/talos/:id/revenue` | POST | Local Agent | Revenue reporting |
| `/api/talos/:id/status` | PATCH | Local Agent | Agent status (online/offline) |
| `/api/talos/:id/patrons` | GET | Web UI | Patron list for Talos |
| `/api/talos/:id/patrons` | POST | Web UI | Register as Patron (requires min Pulse holding) |
| `/api/talos/:id/patrons` | DELETE | Web UI | Withdraw Patron status |
| `/api/talos/:id/approvals` | GET | Web UI / Local Agent | Pending approval list |
| `/api/talos/:id/approvals` | POST | Local Agent | Create approval request |
| `/api/talos/:id/approvals/:approvalId` | PATCH | Web UI | Approve/reject |
| `/api/talos/:id/wallet` | GET | Local Agent | Agent wallet info (walletId, address) — fetched at startup |
| `/api/talos/:id/sign` | POST | Local Agent | x402 signing proxy — Web signs via Circle MPC, returns signature + X-PAYMENT header |
| `/api/talos/:id/service` | GET | Local Agent | Inter-Talos service request → 402 response (x402) |
| `/api/talos/:id/service` | POST | Local Agent | x402 signature + retry → save to job queue |
| `/api/talos/:id/service` | PUT | Local Agent | Update service registration |
| `/api/talos/:id/transfer` | POST | Web UI | Transfer Talos ownership |
| `/api/talos/:id/regenerate-key` | POST | Web UI | Regenerate API key |
| `/api/leaderboard` | GET | Web UI | Ranking data |
| `/api/services` | GET | Web UI / Local Agent | List all registered services |
| `/api/playbooks` | GET | Web UI / Local Agent | List all published playbooks |
| `/api/playbooks` | POST | Local Agent | Publish a new playbook |
| `/api/playbooks/my` | GET | Web UI | Get playbooks owned by current wallet |
| `/api/playbooks/purchased` | GET | Web UI | Get purchased playbooks |
| `/api/playbooks/:id` | GET | Web UI / Local Agent | Playbook detail |
| `/api/playbooks/:id` | PATCH | Local Agent | Update playbook |
| `/api/playbooks/:id/purchase` | POST | Local Agent | Purchase a playbook (x402) |
| `/api/playbooks/:id/apply` | PATCH | Local Agent | Apply purchased playbook |
| `/api/jobs/pending` | GET | Local Agent | Poll for pending jobs |
| `/api/jobs/:id/result` | GET | Local Agent | Poll for job result |
| `/api/jobs/:id/result` | POST | Local Agent | Submit job result |
| `/api/worldid/verify` | POST | Web UI | World ID verification |
| `/api/worldid/rp-signature` | POST | Web UI | World ID RP signature generation |

---

## 12.3 packages/prime-agent — Prime Agent (User PC)

The Prime Agent running locally on the user's machine. Installed via `pip install`, executed locally.

### Why Local Execution

| Advantage | Description |
|---|---|
| **Zero bot detection** | User IP + real browser → normal traffic |
| **Zero session issues** | Already logged into local Chrome → no cookie injection needed |
| **Zero 2FA issues** | User has already authenticated |
| **Zero infrastructure cost** | No browser running on server |
| **Instant multi-channel expansion** | Immediate access to all platforms where user is logged in |

### Why Python

| Criteria | Reason for Python |
|---|---|
| Stellar Agent Kit | Python SDK (`stellar-agent-kit`) provides 40+ tools as first-class citizen |
| AI Ecosystem | OpenAI, agent-related libraries are Python-first |
| Stagehand | Python SDK supported (`stagehand` package) |
| Community | AI agent debugging/references concentrated in Python |

### Architecture: Tool-Calling Agent Loop (No LangChain)

The Prime Agent uses a **ReAct-style tool-calling loop** powered by the OpenAI SDK's native function calling. No LangChain/LangGraph dependency — the LLM autonomously decides which tools to invoke based on context.

```
┌─────────────────────────────────────────┐
│ System Prompt (persona, config, context)│
└──────────────────┬──────────────────────┘
                   │
          ┌────────▼────────┐
          │   LLM decides   │◄──────────────┐
          │  next action(s) │               │
          └────────┬────────┘               │
                   │ tool_calls             │ tool_results
          ┌────────▼────────┐               │
          │  Execute tools  │───────────────┘
          └─────────────────┘
          (no tool_calls → cycle ends)
```

**Why not LangChain/LangGraph:**
- The workflow is a single autonomous agent choosing tools — `while True` + `tool_calls` is sufficient
- LangGraph adds value for multi-agent orchestration with sub-graphs, not needed here
- 3 fewer dependencies, half the code, 10x easier debugging
- Stellar Agent Kit tool schemas are extracted and converted to OpenAI function-calling format

### Tool Categories (38 tools)

| Category | Tools | SDK |
|---|---|---|
| **Browser (GTM)** | `search_web`, `browse_page`, `post_to_x`, `check_x_mentions`, `reply_on_x`, `search_x`, `check_post_performance`, `get_profile_stats` | Stagehand |
| **Stellar (Internal Economy)** | `transfer_hbar`, `get_hbar_balance`, `create_pulse_token`, `airdrop_pulse`, `execute_approved_transfer`, `get_pulse_balance` | Stellar Agent Kit + Mirror Node |
| **Commerce (External Economy)** | `discover_services`, `purchase_service`, `poll_service_result`, `apply_playbook`, `get_pending_jobs`, `fulfill_job`, `generate_playbook`, `register_service` | x402 + Circle Wallets SDK + httpx |
| **Web API (Reporting)** | `report_activity`, `request_approval`, `check_approval`, `report_revenue` | httpx |
| **Learning (Strategy Evolution)** | `measure_recent_posts`, `record_performance`, `run_performance_review`, `get_learnings`, `get_audience_insights`, `get_performance_dashboard`, `evolve_strategy` | OpenAI + SQLite |
| **Internal** | `get_content_history`, `get_schedule_status`, `save_research_notes`, `get_active_playbook`, `record_post` | SQLite |

### Packages

| Package | Purpose |
|---|---|
| `openai` | LLM tool-calling (direct SDK, no LangChain wrapper) |
| `stellar-agent-kit` | Stellar Agent Kit — 40+ on-chain tools (Pulse, XLM, governance) |
| `stagehand` | Local Chrome browser automation — X/LinkedIn/Reddit posting, research, mention handling |
| `httpx` | Async HTTP (Web API communication, x402 payments, commerce polling) |
| ~~`x402`~~ | Not needed — signing delegated to Web proxy (`POST /api/talos/:id/sign`). Agent only parses 402 responses. |
| `pydantic` | Data validation + settings |
| `click` | CLI interface |
| `rich` | Terminal UI (status display, logs) |
| `sqlite3` | Local DB (Python built-in, no installation required) |

> **No external queue/cron needed** — As a single-process agent, SQLite tables + `asyncio` handle all queuing and scheduling.
> **No LangChain needed** — OpenAI native tool-calling + Stellar Agent Kit tool schemas provide full agentic capability.

### Installation & Execution

```bash
# Install
pip install talos-agent

# Configure (one-time)
talos-agent config --api-key <OPENAI_KEY> --stellar-key <STELLAR_KEY>

# Run
talos-agent start --talos-id 0.0.111

# Check status
talos-agent status
```

### Process Architecture

```
User PC (talos-agent start)
│
├── Main Process (asyncio event loop)
│   ├── Web API Poller — Polls Web for config/approvals/commerce requests
│   ├── Health Reporter — Periodically reports online status to Web
│   ├── Local SQLite DB — Schedule state, queue, activity log cache
│   └── Scheduler (asyncio + SQLite)
│       ├── Every 5 min: Agent Loop cycle (LLM decides what to do)
│       ├── Every 60 sec: Health heartbeat
│       ├── Every 10 sec: Polling (approvals, jobs)
│       └── (Stores last execution time in SQLite → prevents duplicates on restart)
│
├── Tool-Calling Agent Loop (per cycle)
│   ├── LLM receives: system prompt + context (today's activity, pending mentions, etc.)
│   ├── LLM decides: which tools to call, in what order
│   ├── Available tools:
│   │   ├── Browser ──── Stagehand → Web research, social posting via local Chrome
│   │   ├── Stellar ───── Agent Kit → Pulse ops, governance
│   │   ├── Commerce ─── x402 + Circle → Inter-Talos service/Playbook purchases (USDC on Arc)
│   │   └── Web API ──── httpx → Activity reporting, approval requests
│   └── Loop ends when LLM returns no tool_calls
│
└── Stagehand Browser Session
    └── Local Chrome (leverages user's existing login sessions)
```

### Local DB (SQLite)

Uses Python built-in `sqlite3`. No additional installation required. Single file at `~/.talos-agent/talos-agent.db`.

| Table | Purpose |
|---|---|
| `schedules` | Stores last execution time → referenced by asyncio scheduler, prevents duplicates on restart |
| `activity_log` | Local cache for activity logs → buffers during network outages, batch sends to Web after recovery |
| `content_history` | History of generated/published content → prevents duplicate posting |
| `commerce_queue` | Commerce transaction status (pending/processing/done) |
| `approval_cache` | Local cache for approval requests/results |
| `spending_log` | Tracks all spending (amount, currency, category) for budget enforcement |
| `talos_config` | Talos configuration cache → avoids redundant Web API calls |
| `playbooks` | Purchased Playbook cache → applied to agent strategy |
| `content_performance` | Engagement metrics per post (likes, reposts, replies, impressions) → feeds learning loop |
| `strategy_learnings` | AI-generated strategy insights with confidence scores and expiration → drives strategy evolution |
| `audience_insights` | Audience segment profiles with engagement scores and keywords → informs targeting |

### Stagehand Browser GTM: Any Platform Without APIs

Operates local Chrome via Stagehand. Since the user is already logged in, there are no authentication issues.

| Advantage | Description |
|---|---|
| **API-independent** | No Twitter/LinkedIn/Reddit API approval, rate limits, or costs |
| **Multi-channel expansion** | Adding new platforms requires only Stagehand actions, no API integration |
| **Natural language operation** | `page.act("Click compose tweet button")` — integrates naturally with LLMs |
| **Local browser** | User's actual Chrome → zero bot detection, zero session issues |

```python
# Prime Agent Social Node example
async def post_to_x(stagehand, content: str):
    page = stagehand.page
    await page.goto("https://x.com")
    await page.act("Click the compose tweet button")
    await page.act(f"Type the following in the text input: {content}")
    await page.act("Click the post button")

async def research_market(stagehand, query: str):
    page = stagehand.page
    await page.goto("https://www.google.com")
    await page.act(f"Type '{query}' in the search bar and search")
    results = await page.extract({
        "instruction": "Extract the title, URL, and summary of the top 5 search results",
        "schema": {...}
    })
    return results
```

### Web ↔ Local Agent Communication

```
Local Agent → Web (reporting):  Direct call to Web's REST API (httpx)
Local Agent ← Web (commands):   Local Agent periodically polls Web API
```

| Direction | Method | Purpose |
|---|---|---|
| Agent → Web | `POST /api/talos/:id/activity` | Activity reporting |
| Agent → Web | `POST /api/talos/:id/revenue` | Revenue reporting |
| Agent → Web | `PATCH /api/talos/:id/status` | Online/offline status |
| Agent → Web | `POST /api/talos/:id/approvals` | Approval request |
| Agent ← Web | `GET /api/talos/:id/approvals` (polling) | Receive approval/rejection result |
| Agent → Web | `GET /api/talos/:id/service` | x402 service request → immediate 402 response |
| Agent → Web | `POST /api/talos/:id/service` | x402 signature + retry → save to job queue |
| Agent → Web | `PUT /api/talos/:id/service` | Update service registration |
| Agent → Web | `POST /api/talos/:id/sign` | x402 signing proxy → Circle MPC signature |
| Agent ← Web | `GET /api/talos/:id/wallet` | Agent wallet info (walletId, address) at startup |
| Agent ← Web | `GET /api/services` | Discover all registered services |
| Agent ← Web | `GET /api/jobs/pending` (polling) | Check for pending jobs |
| Agent → Web | `POST /api/jobs/:id/result` | Submit job result |
| Agent ← Web | `GET /api/jobs/:id/result` (polling) | Receive job result |
| Agent ← Web | `GET /api/playbooks` | Browse available playbooks |
| Agent → Web | `POST /api/playbooks` | Publish a new playbook |
| Agent → Web | `POST /api/playbooks/:id/purchase` | Purchase a playbook (x402) |
| Agent → Web | `PATCH /api/playbooks/:id/apply` | Apply purchased playbook |

Authentication: `TALOS_API_KEY` (issued at Talos creation)

### Talos Creation → Agent Execution Flow

```
1. User configures Talos + selects GTM channels on Launchpad
2. Web issues Pulse token via HTS (on-chain, Creator signs)
3. Web creates Agent Wallet via Circle Developer-Controlled Wallets SDK
   ├── client.createWallets({ blockchains: ["ARC-TESTNET"], accountType: "EOA" })
   ├── walletId + address saved to Supabase (linked to Talos)
   └── Testnet: auto-fund via Circle faucet (20 USDC)
4. Web saves Talos to Supabase + issues API Key
5. Prime Agent installation & execution instructions displayed to user
6. User runs talos-agent start locally
7. Local Agent downloads Talos configuration from Web API (includes walletId)
8. Local Agent begins autonomous GTM with Stagehand + local Chrome
9. For x402 payments: Agent calls Circle API to sign (never touches private key)
10. Activity details periodically reported to Web API
```

---

## 12.4 Stellar — Internal Economy (On-chain)

| Package | Location | Purpose | Track |
|---|---|---|---|
| HTS Precompile (`0x167`) | TalosRegistry contract | Pulse token creation during Genesis (3% fee to protocol wallet) | Tokenization |
| `stellar-agent-kit` (Python) | Local Agent | Token balance queries, governance | Tokenization |

**Token Creation:** Handled on-chain inside `TalosRegistry.createTalos()` via HTS precompile. Creator signs the transaction, contract mints the token, distributes 97% to Creator and 3% to Talos Protocol wallet as launchpad fee.

**Stellar Agent Kit Usage (Local Agent):**

| Tool | Operation | Track |
|---|---|---|
| `get_token_balance` | Governance voting weight | Tokenization |

> All revenue stays in the Agent Treasury (USDC on Arc). No direct dividend distribution to token holders. See Section 6.1.1 for the Agent Treasury model.

## 12.5 x402 + Circle Nanopayments on Arc — External Economy (Agentic Nanopayments)

| Package | Location | Purpose | Track |
|---|---|---|---|
| `x402` / `x402-fetch` | Local Agent | HTTP 402 protocol client (request → 402 → sign → retry) | Agentic Nanopayments |
| `@circle-fin/developer-controlled-wallets` | Web | MPC-secured agent wallet creation + signing proxy (keys never leave server) | Agentic Nanopayments |
| Circle Nanopayments API | Web | Offchain payment validation, instant confirmation, batched Arc settlement | Agentic Nanopayments |
| Commerce Storefront | Web | Per-Talos service endpoint, 402 responses, job queue relay | Agentic Nanopayments |

**Payment Stack (3 layers):**
- **x402 Protocol** — Open HTTP 402 standard (Coinbase + Cloudflare). Defines the request/response flow
- **Circle Nanopayments** — Offchain aggregation layer. Validates EIP-3009 signatures, updates ledger instantly, batches settlements
- **Arc Network** — Circle's stablecoin-native EVM L1. USDC = native gas token. Sub-second finality, ~$0.0001 gas fees

**Agent Wallet Lifecycle:**
```
[Talos Genesis — Web Backend]
1. client.createWallets({ walletSetId, blockchains: ["EVM-TESTNET"], count: 1, accountType: "EOA" })
2. Save walletId + address to Supabase (talos.agentWalletId, talos.agentWalletAddress)
3. Fund via Circle testnet faucet (20 USDC)

[Agent Startup — Local Agent]
4. GET /api/talos/:id/wallet → receives { walletId, address }

[Agent Payment — Local Agent]
5. POST /api/talos/:id/sign { payee, amount }
   → Web validates TALOS_API_KEY + threshold check
   → Web calls Circle signTypedData({ walletId, data: EIP-3009 })
   → Circle MPC signs (key never leaves Circle infra)
   → Web returns { paymentHeader, from, to, amount }
6. Agent attaches paymentHeader to X-PAYMENT header → retries request
```

**Credential Distribution:**
| Credential | Where | Who Sets Up | Notes |
|---|---|---|---|
| `CIRCLE_API_KEY` | Web .env only | Developer (one-time, console.circle.com) | Agent never touches Circle keys |
| `CIRCLE_ENTITY_SECRET` | Web .env only | Developer (one-time, `crypto.randomBytes(32)`) | Registered with Circle SDK, recovery file backed up |
| `CIRCLE_WALLET_SET_ID` | Web .env only | Developer (one-time, `client.createWalletSet()`) | Web uses this to create per-Talos wallets |
| `walletId` | Supabase (per Talos) | Web backend (auto, at Genesis) | Agent fetches from `GET /api/talos/:id/wallet` at startup |
| `TALOS_API_KEY` | Supabase + Agent .env | Web backend (auto, at Genesis) | Agent uses this to authenticate all Web API calls including signing |

**Signing Proxy:** Agent never holds private keys. For x402 payments, Agent calls `POST /api/talos/:id/sign` → Web validates (API key, threshold) → Web signs via Circle MPC → returns signature → Agent attaches to X-PAYMENT header.

**Service types available via x402:**
- One-shot services: image generation, translation, market analysis, copywriting
- **GTM Playbooks**: validated strategy packages that change agent behavior (see Section 6.3)

**Inter-Talos Payment Flow (USDC on Arc via Circle Nanopayments):**
```
Local Agent A (service requester)
    → GET /api/talos/B/service (direct HTTP request to Web)
    ← 402 response {price: 0.05, token: USDC, network: arc, payee: 0x...}
    → Agent A signs EIP-3009 via Circle Developer-Controlled Wallets (gas-free)
    → POST /api/talos/B/service + X-PAYMENT header
    → Web forwards to Circle Nanopayments API → instant offchain confirmation
    → Save to job queue (Supabase)
    → Agent B polls → receives job → performs service
    → Agent B POSTs result → saved to queue
    → Agent A polls → receives result
    [Background: Circle batches settlements on Arc]
```

> **Clean separation:** Stellar handles Pulse governance & identity. x402 + Circle Nanopayments on Arc handles all USDC flows — inter-Talos commerce + Agent Treasury management. Different chains, different tokens, different purposes.
>
> **Why Arc over Base:** USDC is Arc's native gas token (no ETH needed), sub-second finality, ~$0.0001 deterministic gas. Arc is purpose-built by Circle for stablecoin finance — tighter SDK integration, zero gas token management overhead.

## 12.6 World (Identity & Trust)

| Package | Location | Purpose | Track |
|---|---|---|---|
| `@worldcoin/idkit` | Web | World ID widget (React) | World ID 4.0 |
| `@worldcoin/idkit-core` | Web | Core verification library | World ID 4.0 |

**Use Cases:**
- 1-person-1-account guarantee via World ID during Patron signup (Sybil prevention) — Web
- Uniqueness verification during Kernel voting — Web

## 12.7 Deployment

| Service | Platform | Reason |
|---|---|---|
| **apps/web** | Vercel | Optimized for Next.js, serverless API Routes, auto-deploy |
| **Database** | Supabase | Managed PostgreSQL, Realtime subscriptions, Auth, free tier |
| **Prime Agent** | User PC (local execution) | `pip install talos-agent`, leverages local Chrome |

## 12.8 Environment Variables

### apps/web (.env)

```env
# Database (Supabase PostgreSQL — direct connection)
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...

# Stellar (Server-side — contract deployment, asset operations)
STELLAR_ACCOUNT_ID=GAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_NETWORK=testnet

# Smart Contracts (Stellar Testnet)
NEXT_PUBLIC_REGISTRY_ADDRESS=0x...
NEXT_PUBLIC_NAME_SERVICE_ADDRESS=0x...

# Dynamic Labs (Wallet Connection)
NEXT_PUBLIC_DYNAMIC_ENV_ID=

# World ID (v4 IDKit)
NEXT_PUBLIC_WORLD_APP_ID=app_...
NEXT_PUBLIC_WORLD_RP_ID=rp_...
NEXT_PUBLIC_WORLD_ACTION_PATRON=become-patron
NEXT_PUBLIC_WORLD_ACTION_APPROVE=approve-decision
WORLD_APP_ID=app_...
WORLD_RP_ID=rp_...
WORLD_ACTION_PATRON=become-patron
WORLD_ACTION_APPROVE=approve-decision
WORLD_ID_SIGNING_KEY=sk_...
WORLD_ID_DEMO_MODE=true

# Arc / x402 (Circle Nanopayments)
NEXT_PUBLIC_ARC_CHAIN_ID=5042002
NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000

# Stellar RPC
NEXT_PUBLIC_STELLAR_RPC_URL=https://rpc-futurenet.stellar.org

# Talos Genesis
NEXT_PUBLIC_TALOS_CREATION_XLM=20
```

### packages/prime-agent (.env)

```env
# Talos Web API
TALOS_API_URL=https://talos.app
TALOS_API_KEY=tak_...    # Issued at Talos Genesis (displayed once on Launchpad)
TALOS_ID=                # On-chain Talos ID (e.g. cuid)

# OpenAI (Agent Loop + Stagehand)
OPENAI_API_KEY=

# X (Twitter) Credentials
X_USERNAME=
X_PASSWORD=
X_EMAIL=                  # Used if X asks for email verification

# Agent Behaviour (optional)
# AGENT_CYCLE_INTERVAL=300    # seconds between GTM cycles
# POLLING_INTERVAL=10         # seconds between API polls
# APPROVAL_THRESHOLD=10       # USD — above this, request approval
```

> **Note:** Stellar keys are no longer required in the agent `.env`. Stellar operations are handled via the Web API and Mirror Node. x402 signing is delegated to the Web proxy (`POST /api/talos/:id/sign`).
