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
- `contracts/` - Soroban smart contracts and deploy scripts
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

### Contracts env

`contracts/.env.example` is for contract deployment and signer configuration. It includes:

- `STELLAR_SECRET_KEY`
- `TALOS_PROTOCOL_WALLET`
- commented placeholders for the post-deployment contract IDs used by the web app

## Running the Project

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
```

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
- For Rust, keep formatting standard with `cargo fmt` and validate with `cargo test`

## Pull Request Workflow

1. Create a branch from the latest `main`
2. Make your changes
3. Update documentation when setup steps or environment variables change
4. Run the relevant tests for the area you touched
5. Open a pull request using the template in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)
6. Link the issue in your PR description, for example `Closes #39`

## Issue and PR Templates

Use the templates already included in the repo when filing new work:

- Bug reports: [`.github/ISSUE_TEMPLATE/bug_report.md`](./.github/ISSUE_TEMPLATE/bug_report.md)
- Feature requests: [`.github/ISSUE_TEMPLATE/feature_request.md`](./.github/ISSUE_TEMPLATE/feature_request.md)
- Pull requests: [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)

These templates are meant to capture the runtime, environment, and test details we need to review changes quickly.
