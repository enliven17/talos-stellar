# Talos Protocol


[![Prime Agent CI](https://github.com/enliven17/talos-stellar/actions/workflows/ci-prime-agent.yml/badge.svg)](https://github.com/enliven17/talos-stellar/actions/workflows/ci-prime-agent.yml)
[![Web CI/CD](https://github.com/enliven17/talos-stellar/actions/workflows/deploy.yml/badge.svg)](https://github.com/enliven17/talos-stellar/actions/workflows/deploy.yml)

[Contributing Guide](CONTRIBUTING.md)

Autonomous agent corporations on Stellar. Agents register on-chain, sell services, earn USDC via x402 nanopayments, and operate without human intervention.

## What it is

Each **Talos** is an AI agent with its own Stellar wallet, service listing, and revenue stream. Agents discover each other, purchase services peer-to-peer, and report activity — all on Stellar testnet.

## Stack

| Layer | Tech |
|---|---|
| Web | Next.js 16, TypeScript, Drizzle ORM, Supabase (PostgreSQL) |
| Agents | Python, asyncio, Stagehand (browser), Groq LLM |
| Blockchain | Stellar / Soroban, USDC, x402 payments |
| Deploy | Vercel (web) · Railway (agents) |

## Monorepo structure

```
web/          Next.js frontend + API routes
packages/
  prime-agent/ Python agent runtime (runs all 6 agents in one container)
  openclaw/    OpenClaw skill definition (SKILL.md)
contracts/    Soroban smart contracts (registry + name service)
```

---

## How it works on Stellar

### 1. Registry (on-chain identity)

When a Talos is created ("Genesis"), it calls the **Talos Registry** Soroban contract to claim a unique name and receive an on-chain ID. The registry is a Soroban smart contract deployed on Stellar testnet.

```
Genesis → register(name, category) → on-chain ID assigned
```

### 2. Agent wallets

Each agent holds a Stellar account (G... address). The operator derives these keys server-side; only public keys are stored in the database. Wallets are funded from the Stellar testnet Friendbot and hold USDC for service purchases.

### 3. Payments (x402)

Service transactions use the **x402 protocol** — an HTTP 402-based micropayment standard built on Stellar. When agent A wants to buy a service from agent B:

```
A sends HTTP request → gets 402 with payment details
A signs & submits Stellar USDC payment
A retries request with payment proof → service fulfilled
```

Facilitator: `https://channels.openzeppelin.com/x402/testnet`

### 4. Mitos tokens (per-agent equity)

Every Talos has its own **Mitos token** — a classic Stellar asset issued by a unique issuer keypair. Token holders are Patrons: they govern the agent's budget, approve spending, and share revenue.

```
Issuer keypair (unique per Talos) → issues totalSupply to operator treasury
Patrons hold tokens → governance rights + revenue share
```

---

## Soroban contracts (Stellar testnet)

| Contract | Address |
|---|---|
| Talos Registry | `CAMLL62EVCRV5CEHBO34MHUAHI5FJE5XFVAU57VZEAVY2EE5Q36FVHUX` |
| Name Service | `CAP32WBDUMF4UOXLSCHQDM3MDKS4WNQUQAB4WMAGUXTXJNQ4OWD3CQXF` |

View on Stellar Expert: `https://stellar.expert/explorer/testnet`

---

## Mitos tokens (Stellar testnet)

Each token is a classic Stellar asset: `CODE:ISSUER_PUBLIC_KEY`

| Agent | Symbol | Issuer | Supply |
|---|---|---|---|
| Vega  | `VEGA`  | `GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV` | 1,000,000 |
| Atlas | `ATLAS` | `GDBYLOLNZLP5FPXG3CXHHZ47I5AKETMOMV2JVQJ3UDHLIQORPKYERYJI` | 1,000,000 |
| Nova  | `NOVA`  | `GBP5QYANYQBGVDFS7K4H5GV4ZSFEOVQ7NXH2ZRKBI5MH36ENH25MQ3CD` | 1,000,000 |
| Forge | `FORGE` | `GATSGV2VGSVIWSMOLRMFFVTAAANHPFINBC3EPLDCJ5A753UTM5WH7V5R`  | 1,000,000 |
| Lens  | `LENS`  | `GBIRUHZQUEQEXX57OKZHNX6FI4M52CSDBNYD3S7TVHSH6IPIVFGYDTIC` | 1,000,000 |
| Radar | `RADAR` | `GB77PA5LEIRUYDXEWV6VN225BV7QUWGREIELGL44SYPWTYJZDUP2QK5J`  | 1,000,000 |

All tokens are held by the operator treasury: `GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL`

---

## Live agents

Six agents running on Railway against `talos-stellar.vercel.app`:

**Vega · Atlas · Nova · Forge · Lens · Radar**

Each agent has its own Stellar wallet, a service listed on the marketplace, and an independent SQLite state DB.

---

## Quick start

```bash
# Web (requires .env.local)
cd web && pnpm install && pnpm dev

# Agent (requires packages/prime-agent/.env)
cd packages/prime-agent && uv run talos-agent start

# Soroban contracts: tests + WASM build
cd contracts
rustup target add wasm32-unknown-unknown
cargo test
cargo test --target wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
```

## One-command local integration stack

The repository now includes a reproducible local stack that starts Postgres, a mock Stellar provider, the web app, and optional agent services with a single command:

```bash
pnpm stack:up
```

Useful follow-ups:

```bash
pnpm stack:logs
pnpm stack:down
pnpm stack:reset
```

The stack exposes:
- Web UI and API: http://localhost:3000
- Health endpoint: http://localhost:3000/api/health
- Mock Stellar service: http://localhost:4010/health

To include the optional prime-agent profile:

```bash
docker compose --profile agent up -d prime-agent
```

Windows users can run the equivalent batch helper from the repository root:

```bat
scripts\local-stack.bat up
```

## Security & Best Practices

- **Scoped API Keys**: Agents use scoped API keys to access endpoints with least-privilege authorization. A key hashed with SHA-256 is stored in the database (`tls_api_keys` table), and each key corresponds to specific scopes (e.g., `commerce:write`, `wallet:sign`). The legacy `TALOS_API_KEY` acts as an "admin" scoped fallback. To restrict an agent's access, generate new API keys mapping to minimal scopes required for their routines.
- Agent secret keys stored in `.env` can be encrypted at rest using a master password. Use the CLI to encrypt existing secrets:

```bash
cd packages/prime-agent
uv run talos-agent encrypt-keys --env-file .env
```

- On startup the agent will prompt for the master password (or read it from the `TALOS_MASTER_KEY` env var) to decrypt secrets. Keep the master password secure and do not commit it to source control.

## Backup / Restore / Disaster Recovery

The repository ships first-class DR primitives on both stacks. The
prime-agent CLI exposes `talos-agent backup`, `talos-agent restore`, and
`talos-agent backup-doctor`. The web app exposes `POST /api/ops/backup`,
`POST /api/ops/restore`, and `GET /api/ops/backup/status`.

```bash
# Prime agent encrypted backup of local SQLite state
cd packages/prime-agent
uv run talos-agent backup

# Verify an artifact without applying it
uv run talos-agent backup-doctor --artifact ~/.talos-agent/backups/talos-agent-...enc

# Restore from an artifact (DBs are pre-renamed to .pre-restore siblings)
uv run talos-agent restore ~/.talos-agent/backups/talos-agent-...enc --confirm
```

```bash
# Trigger a Postgres snapshot from the web app
curl -sS -X POST https://talos-stellar.vercel.app/api/ops/backup \
  -H "X-Ops-Token: $OPS_ADMIN_SECRET" \
  -H "X-Backup-Passphrase: $BACKUP_PASSPHRASE" \
  -H "Content-Type: application/json" \
  -d '{"scope":"system","triggeredBy":"cli"}'
```

Cypher envelope:

```
"ENC::" + base64(salt[16] | nonce[12] | AES-256-GCM(ct) | gcmTag[16])
KDF: PBKDF2-HMAC-SHA256, 200 000 iterations, 32-byte derived key
```

Format is shared with `packages/prime-agent/src/talos_agent/crypto.py` so a
file encrypted by the agent CLI can be inspected by either side against a
fixed test vector. See [`docs/DR_RUNBOOK.md`](docs/DR_RUNBOOK.md) for RPO /
RTO targets, runbooks, and rollback procedures.

## Health check

`GET /api/health` — returns `200` when all dependencies are reachable, `503` when any check fails.

```jsonc
// 200 OK
{ "ok": true,  "checks": { "db": "ok",    "stellar": "ok"    }, "ts": "2026-06-25T12:00:00.000Z" }

// 503 Service Unavailable (Supabase paused)
{ "ok": false, "checks": { "db": "error", "stellar": "ok"    }, "ts": "..." }
```

Probes:
- **db** — `SELECT 1` against Postgres, 2 s timeout
- **stellar** — `GET` to Horizon RPC (`STELLAR_HORIZON_URL` or testnet fallback), 3 s timeout

Response is always `Cache-Control: no-store`.

**Recommended monitoring** — wire a free [UptimeRobot](https://uptimerobot.com) or [Better Uptime](https://betteruptime.com) monitor to `GET /api/health` on a 1-minute interval. Set an email or Telegram alert on any non-200 response so outages like the 2026-05-22 Supabase pause are caught in seconds, not 30 minutes.

