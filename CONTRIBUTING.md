# Contributing to Talos Protocol

Thanks for helping improve Talos Protocol. This monorepo contains a Next.js web app, a Python agent runtime, and Soroban contracts, so most changes only need the setup for the subproject they touch.

## Prerequisites

- Node.js 20 or newer
- pnpm 9 or newer
- Python 3.11 or newer
- uv for Python dependency management
- Rust stable with the `wasm32-unknown-unknown` target
- Soroban CLI configured for Stellar testnet contract work

## Clone and Install

```bash
git clone https://github.com/enliven17/talos-stellar.git
cd talos-stellar
pnpm install
```

The web app keeps its environment example in `web/.env.example`. Copy it before running local web or API routes:

```bash
cp web/.env.example web/.env.local
```

Agent runtime secrets are loaded from `packages/prime-agent/.env`. Create that file locally when working on the agent service, and do not commit real keys or API tokens.

## Web App

The web app lives in `web/` and contains the Next.js frontend plus API routes.

```bash
pnpm install
pnpm dev
pnpm lint
pnpm --dir web test:e2e
```

For database work, use the web package scripts:

```bash
pnpm web:db:push
pnpm web:db:seed
```

## Agent Runtime

The Prime Agent service lives in `packages/prime-agent/`.

```bash
cd packages/prime-agent
uv sync --extra dev
uv run talos-agent start
uv run pytest
```

Use this setup for changes under `packages/prime-agent/src/talos_agent/`, including browser automation, scheduler, tool registry, and payment logic.

## Soroban Contracts

The contracts live in `contracts/`.

```bash
cd contracts
cargo test
cargo build --target wasm32-unknown-unknown --release
```

Use the package scripts when you want the named contract commands:

```bash
pnpm --dir contracts test
pnpm --dir contracts build:registry
pnpm --dir contracts build:name-service
```

Deploy commands target Stellar testnet and require a configured Soroban account:

```bash
pnpm --dir contracts deploy:testnet
pnpm --dir contracts deploy:name-service:testnet
```

## Pull Request Checklist

Before opening a PR:

- Link the related issue with `Closes #N` or `Fixes #N`.
- Keep the change focused on one issue.
- Run the checks for every subproject you changed.
- Include screenshots or screen recordings for UI changes.
- Document any skipped checks with the reason.
- Verify that no secrets, private keys, or local `.env` files are committed.

The PR template in `.github/PULL_REQUEST_TEMPLATE.md` lists the same expectations so reviewers can triage changes quickly.
