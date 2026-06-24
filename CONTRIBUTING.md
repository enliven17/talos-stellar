# Contributing to Talos Protocol

Thank you for your interest in contributing to Talos Protocol! This document provides instructions for setting up your local environment, running the services, executing tests, and submitting your contributions.

## Prerequisites

Before getting started, make sure you have the following installed:
- **Node.js**: Version 20 or higher
- **pnpm**: Version 9 or higher
- **Python**: Version 3.11 or higher
- **uv**: Python package manager
- **Rust**: Latest stable toolchain (required for Soroban smart contracts)
- **Stellar CLI** (previously Soroban CLI): For contract deployment and local development

## Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Muyideen-js/talos-stellar.git
   cd talos-stellar
   ```

2. **Install frontend/web dependencies:**
   ```bash
   pnpm install
   ```

## Environment Setup

You need to configure the environment variables for each subproject:

- **Web (Next.js)**: Copy [web/.env.example](file:///c:/Users/Wittig_Lyon/Desktop/wae/wave%206/talos-stellar/web/.env.example) to `web/.env.local` and fill in the required values.
- **Prime Agent (Python)**: Copy [packages/prime-agent/.env.example](file:///c:/Users/Wittig_Lyon/Desktop/wae/wave%206/talos-stellar/packages/prime-agent/.env.example) to `packages/prime-agent/.env` and configure your API keys.
- **Contracts (Soroban)**: Copy [contracts/.env.example](file:///c:/Users/Wittig_Lyon/Desktop/wae/wave%206/talos-stellar/contracts/.env.example) to `contracts/.env` if you plan to deploy or invoke contracts directly via scripts.

## Running the Project

### 1. Web Application
To run the Next.js frontend and local API:
```bash
cd web
pnpm dev
```
Alternatively, from the repository root:
```bash
pnpm dev
```

### 2. Prime Agent CLI
To start the AI agent runtime:
```bash
cd packages/prime-agent
uv run talos-agent start
```

---

## Running Tests

Verify that your changes do not break existing functionality by running tests before submitting a PR.

### 1. Contracts Tests (Soroban)
Run the Rust-based smart contract tests:
```bash
cd contracts
cargo test
```

### 2. Agent Tests (Python)
Run python-based agent runtime tests:
```bash
cd packages/prime-agent
uv run --extra dev pytest
```

### 3. Web E2E Tests (Next.js/Vitest)
Run the web application end-to-end API tests:
```bash
cd web
pnpm test:e2e
```

---

## Submitting a Pull Request

1. Create a new branch for your fix or feature:
   ```bash
   git checkout -b feature/my-amazing-feature
   ```
2. Make your changes and commit them with descriptive commit messages following the Conventional Commits style.
3. Ensure all tests pass.
4. Push your branch and open a Pull Request. Your PR will auto-populate with the [Pull Request Template](file:///c:/Users/Wittig_Lyon/Desktop/wae/wave%206/talos-stellar/.github/PULL_REQUEST_TEMPLATE.md).
