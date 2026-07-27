# Contributing to Talos Protocol

Thanks for helping improve Talos Protocol. This guide covers the local development setup for the Node.js, Python, and Rust parts of the monorepo, the required environment files, and the workflow we expect for pull requests.

If you are looking for a good place to start, browse the open Wave issues:
https://github.com/enliven17/talos-stellar/issues?q=is%3Aissue+is%3Aopen+label%3A%22Stellar+Wave%22

## Prerequisites

Install these before you start working locally:

- Node.js 20 or newer
- pnpm 9 or newer
- Python 3.11 or newer
- `uv`
- Rust stable toolchain and `cargo`
- Soroban CLI, installed as `stellar` via `cargo install --locked stellar-cli --features opt`

For the Rust contracts, also add the Wasm target:

```bash
rustup target add wasm32-unknown-unknown
```

## Repository Layout

- `web/` - Next.js application, API routes, and frontend
- `packages/prime-agent/` - Python agent runtime
- `contracts/` - Soroban smart contracts and deploy scripts (see `contracts/EVENTS.md` for the event schema)
- `packages/openclaw/` - skill definitions and agent helper code

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/enliven17/talos-stellar.git
cd talos-stellar
```

### 2. Install Node.js dependencies

Install the workspace dependencies from the repository root:

```bash
pnpm install
```

If you only need the web app, you can still work from the root with `pnpm dev` because the root package forwards to `web/`.

### 3. Set up Python with `uv`

Install the agent dependencies and the dev extras:

```bash
cd packages/prime-agent
uv sync --extra dev
```

Run the agent with:

```bash
uv run talos-agent start
```

### 4. Set up Rust and Soroban

From `contracts/`:

```bash
cargo test
cargo build --target wasm32-unknown-unknown --release
```

To deploy the contracts to testnet, use the provided script from a Bash-compatible shell:

```bash
./deploy.sh testnet
```

The script prints the deployed contract IDs that need to be copied into the web app environment file.

## Environment Files

The repo already includes verified example files for each runtime. Copy them before running locally:

- `web/.env.example` -> `web/.env.local`
- `packages/prime-agent/.env.example` -> `packages/prime-agent/.env`
- `contracts/.env.example` -> `contracts/.env`

### Web app env

`web/.env.example` contains the web app, database, Stellar, x402, and AI service variables. The most important entries are:

- `DATABASE_URL` and `DIRECT_URL`
- `STELLAR_NETWORK`, `STELLAR_HORIZON_URL`, and `STELLAR_RPC_URL`
- `STELLAR_OPERATOR_SECRET_KEY` and `STELLAR_OPERATOR_PUBLIC_KEY`
- `NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY`
- `NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT` and `NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT`
- `X402_FACILITATOR_URL`, `X402_API_KEY`, and `X402_SETTLEMENT_NETWORK`
- `GROQ_API_KEY` or `OPENAI_API_KEY`
- `TAVILY_API_KEY`

If you deploy new contracts, update the contract IDs in `web/.env.local` with the values printed by `contracts/deploy.sh`.

### Prime agent env

`packages/prime-agent/.env.example` configures the Talos agent runtime. It documents:

- `TALOS_API_KEY` or `TALOS_API_KEYS`
- `TALOS_ID` and `TALOS_API_URL`
- `GROQ_API_KEY` or `OPENAI_API_KEY`
- `X_USERNAME`, `X_PASSWORD`, and `X_EMAIL`
- `BROWSER_HEADLESS`
- agent timing and approval settings such as `AGENT_CYCLE_INTERVAL`, `POLLING_INTERVAL`, and `APPROVAL_THRESHOLD`
- opt-in durable job inbox/outbox settings under `TALOS_DURABLE_JOB_EFFECTS_*` and `TALOS_JOB_EFFECT_*`

### Contracts env

`contracts/.env.example` is for contract deployment and signer configuration. It includes:

- `STELLAR_SECRET_KEY`
- `TALOS_PROTOCOL_WALLET`
- commented placeholders for the post-deployment contract IDs used by the web app

## Running the Project

### One-command local integration stack

A reproducible local integration stack is available for contributors:

```bash
pnpm stack:up
```

This starts PostgreSQL, a mock Stellar provider, the web app, and seeds the local database. The web service exposes health and readiness endpoints at `/api/health` and `/api/health/ready`.

Use these commands to manage the environment:

```bash
pnpm stack:logs
pnpm stack:down
pnpm stack:reset
```

The stack defaults to the web service and a mock Stellar provider. Add the optional prime-agent service with:

```bash
docker compose --profile agent up -d prime-agent
```

### Web

From the repo root:

```bash
pnpm dev
```

Or from `web/`:

```bash
cd web
pnpm dev
```

Other useful web commands:

```bash
pnpm build
pnpm lint
pnpm test:unit
pnpm test:e2e
pnpm test:bench       # Run performance benchmarks
```

See [BENCHMARKS.md](./BENCHMARKS.md) for the benchmark system documentation.

Any PR that changes `web/drizzle/**` or `web/src/db/**` is validated by the `Web Migrations CI`
workflow, which applies your migrations to an ephemeral Postgres instance. See
[`MIGRATIONS.md`](./MIGRATIONS.md) for what it checks, how to reproduce it locally, and rollback
guidance.

### Prime Agent

```bash
cd packages/prime-agent
uv run talos-agent start
```

### Contracts

```bash
cd contracts
cargo test
cargo build --target wasm32-unknown-unknown --release
```

If you are iterating on contract behavior, also run the Wasm-target test path used by CI:

```bash
cargo test --target wasm32-unknown-unknown
```

## Code Style

- Keep changes small and focused
- Match the existing patterns in the area you are editing
- Prefer descriptive names over clever abstractions
- Add or update tests when behavior changes
- Do not commit secrets, keys, or generated `.env` files
- For TypeScript and React, run `pnpm lint` and the relevant `pnpm test:*` command before opening a PR
- For Python, prefer explicit types and validate changes with `uv run pytest`
- For provider job-effect changes, also run
  `uv run pytest tests/test_durable_job_effects.py` and follow the
  [durable job effects runbook](./docs/prime-agent-durable-job-effects.md).
- For Rust, keep formatting standard with `cargo fmt` and validate with `cargo test`

## Database Transaction Retry & Serialization Hardening

Critical database state transitions (money, token purchases, patron creation, job state transitions, agent genesis) use `withTransactionRetry` from `web/src/db/db-retry.ts` to automatically recover from PostgreSQL serialization conflicts (`40001`), deadlocks (`40P01`), lock timeouts (`55P03`), and transient connection failures.

### Environment Configuration

- `DB_TRANSACTION_RETRY_ENABLED`: Controls transaction retry behavior (default: `true`). Set to `false` to disable retries instantly.
- `DB_TRANSACTION_RETRY_MAX_RETRIES`: Maximum number of retry attempts (default: `5`).
- `DB_TRANSACTION_RETRY_INITIAL_DELAY_MS`: Initial exponential backoff delay in milliseconds (default: `50`).
- `DB_TRANSACTION_RETRY_MAX_DELAY_MS`: Maximum exponential backoff cap in milliseconds (default: `1000`).

### Operational Signals & Observability

Retries emit structured Pino log events with domain categories (`MONEY`, `TOKEN`, `PATRON`, `JOB`, `GENESIS`):

- `db_transaction_retry_attempt` (`logger.warn`): Logged when a retryable serialization/connection error triggers a retry attempt.
- `db_transaction_retry_success` (`logger.info`): Logged when a transaction succeeds after prior failed attempts.
- `db_transaction_retry_exhausted` (`logger.error`): Logged when maximum retry attempts are exceeded.

Sensitive data (keys, passphrases, raw payloads) are excluded from log context.

### Local Verification

To run unit and concurrency contention tests:

```bash
pnpm --filter web exec vitest run tests/db-retry.unit.test.ts tests/db-retry.contention.test.ts
```

### Rollback Guidance

If operational issues or database performance degradation occur:

1. Set `DB_TRANSACTION_RETRY_ENABLED=false` in `web/.env.local` or application environment variables.
2. Restart the web server. This immediately falls back to single-attempt database transactions without requiring application redeployments or code rollbacks.

## SDK Event Stream (`TalosEventStream`)

The `packages/sdk` package exports a browser and Node-compatible SSE client for the Talos platform event stream.

### Quick start

```ts
import { TalosEventStream, InMemorySeenStore } from "@talos-protocol/sdk";

const stream = new TalosEventStream("https://talos-stellar.vercel.app", {
  authHeader: "Bearer <api-key>",
  seenStore: new InMemorySeenStore(), // optional, suppresses duplicates on reconnect
});

stream.on("event", (evt) => console.log(evt.type, evt.data));
stream.on("error", (err, attempt) => console.error("attempt", attempt, err));
stream.on("close", () => console.log("stream closed"));

stream.connect();

// To stop:
stream.close();
```

### Configuration reference

| Option                 | Default       | Notes                                                     |
| ---------------------- | ------------- | --------------------------------------------------------- |
| `path`                 | `/api/events` | Stream endpoint path                                      |
| `authHeader`           | —             | Sent as `Authorization` header. Never logged.             |
| `maxReconnectAttempts` | `10`          | Total attempts before permanent close                     |
| `baseReconnectDelayMs` | `1000`        | Base delay; doubles per attempt                           |
| `maxReconnectDelayMs`  | `30000`       | Backoff ceiling                                           |
| `jitter`               | `true`        | Full-jitter on reconnect delay                            |
| `maxHeartbeatMisses`   | `3`           | Consecutive missed heartbeat ticks before stall reconnect |
| `heartbeatIntervalMs`  | `30000`       | Heartbeat watchdog interval                               |
| `seenStore`            | —             | `SeenStore` implementation for duplicate suppression      |
| `signal`               | —             | External `AbortSignal` to close the stream                |

### Operational signals

The optional `logger` receives structured, privacy-safe events (no payloads, no credentials):

| Event                      | Level | Meaning                                         |
| -------------------------- | ----- | ----------------------------------------------- |
| `sse:connecting`           | info  | Initial connect or reconnect                    |
| `sse:reconnect_scheduled`  | info  | Reconnect delay queued with `delayMs`           |
| `sse:duplicate_suppressed` | info  | An event ID was already in `seenStore`          |
| `sse:error`                | warn  | Connection error, `attempt` included            |
| `sse:heartbeat_miss`       | warn  | No server activity during watchdog interval     |
| `sse:stall_detected`       | warn  | `maxHeartbeatMisses` reached; forcing reconnect |
| `sse:budget_exhausted`     | warn  | All reconnect attempts used                     |
| `sse:handler_error`        | error | An `on("event")` handler threw                  |

Pass any `{ info, warn, error }` compatible logger (e.g. `pino`, `console`):

```ts
import pino from "pino";
const stream = new TalosEventStream(url, { logger: pino(), authHeader });
```

### Duplicate suppression

`InMemorySeenStore` (capacity 10 000, LRU eviction) covers process-lifetime dedup.
For cross-restart guarantees supply a persistent implementation:

```ts
class RedisSeenStore implements SeenStore {
  async has(id: string) {
    return Boolean(await redis.exists(`seen:${id}`));
  }
  async add(id: string) {
    await redis.set(`seen:${id}`, 1, "EX", 86400);
  }
}
```

### Rollback

`TalosEventStream` is additive — no existing API surface changed. To disable the feature: simply don't call `connect()`, or `close()` the stream immediately.

### Compatibility notes

- Requires `fetch` and `ReadableStream` (native in browsers and Node ≥ 18).
- In Node 18 you may need `--experimental-fetch` if not enabled by default; Node 20+ needs nothing.
- The `fetch` option in `TalosEventStreamOptions` lets you inject a polyfill or mock for older runtimes and tests.

### Local verification

```bash
cd packages/sdk
npm test        # runs vitest — all 93 tests should pass
npm run build   # tsc compile check
```

## Pull Request Workflow

1. Create a branch from the latest `main`
2. Make your changes
3. Update documentation when setup steps or environment variables change
4. Run the relevant tests for the area you touched
5. Open a pull request using the template in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)
6. Link the issue in your PR description, for example `Closes #39`

## Releases

Versioning, changelogs, and tagging for `web`, `sdk`, `agent`, and `contracts` are automated —
see [`RELEASES.md`](./RELEASES.md). You don't need to do anything for this beyond writing
[Conventional Commits](https://www.conventionalcommits.org/) subjects (`feat: ...`, `fix: ...`,
etc.) in your PRs; version bumps are computed from those.

## Issue and PR Templates

Use the templates already included in the repo when filing new work:

- Bug reports: [`.github/ISSUE_TEMPLATE/bug_report.md`](./.github/ISSUE_TEMPLATE/bug_report.md)
- Feature requests: [`.github/ISSUE_TEMPLATE/feature_request.md`](./.github/ISSUE_TEMPLATE/feature_request.md)
- Pull requests: [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)

These templates are meant to capture the runtime, environment, and test details we need to review changes quickly.
