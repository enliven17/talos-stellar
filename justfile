# Cross-package task runner for Talos Protocol
# Install: https://github.com/casey/just
# On Linux/macOS: `cargo install just`
# On Windows: `winget install casey.just` or `scoop install just`
# Run commands from the repository root: `just <recipe>`
#
# Windows note: Some recipes (stack-*) use Bash scripts. On Windows, use WSL or
# Git Bash for those commands, or use the equivalent pnpm scripts from the root
# package.json.

# Default recipe - list available recipes
default:
    @just --list

# ─────────────────────────────────────────────────────────────────────────────
# Test recipes (matching CI commands)
# ─────────────────────────────────────────────────────────────────────────────

# Run all web package tests (typecheck, lint, unit, payment coverage, a11y)
test-web:
    @echo "Running web tests..."
    cd web && npx tsc --noEmit
    cd web && pnpm lint
    cd web && pnpm test:unit
    cd web && pnpm test:payment-coverage
    cd web && pnpm test:a11y

# Run SDK package tests (build, test)
test-sdk:
    @echo "Running SDK tests..."
    cd packages/sdk && pnpm run build
    cd packages/sdk && pnpm run test

# Run prime-agent package tests (lint, pytest with coverage)
test-agent:
    @echo "Running prime-agent tests..."
    cd packages/prime-agent && uv run ruff check src tests scripts
    cd packages/prime-agent && uv run pytest tests/ -v --cov --cov-report=json --cov-report=term
    cd packages/prime-agent && uv run python scripts/check-coverage.py coverage.json

# Run contracts package tests (cargo test, WASM build)
test-contracts:
    @echo "Running contracts tests..."
    cd contracts && cargo test
    cd contracts && cargo build --target wasm32-unknown-unknown --release

# Run all package tests
test-all: test-web test-sdk test-agent test-contracts

# ─────────────────────────────────────────────────────────────────────────────
# Lint recipes
# ─────────────────────────────────────────────────────────────────────────────

# Run lint for all packages
lint-all:
    @echo "Running lint for all packages..."
    cd web && pnpm lint
    cd packages/prime-agent && uv run ruff check src tests scripts

# ─────────────────────────────────────────────────────────────────────────────
# Stack recipes (use pnpm scripts from root package.json on Windows)
# ─────────────────────────────────────────────────────────────────────────────

# Start the local integration stack (PostgreSQL, mock Stellar, web app)
stack-up:
    @echo "Starting local integration stack..."
    pnpm stack:up

# Stop the local integration stack
stack-down:
    @echo "Stopping local integration stack..."
    pnpm stack:down

# View logs from the local integration stack
stack-logs:
    @echo "Viewing local integration stack logs..."
    pnpm stack:logs

# Reset the local integration stack (destroy volumes and re-import)
stack-reset:
    @echo "Resetting local integration stack..."
    pnpm stack:reset

# Reset local test data only (safe reset, requires --yes flag)
stack-reset-data *args:
    @echo "Resetting local test data..."
    pnpm stack:reset-data {{args}}
