# Talos Protocol — Product Requirements Document

> "The operating system for autonomous agent corporations"

---

## 1. Overview

Talos Protocol lets users turn a product or service into a fully autonomous **agent corporation (Talos)** — a Prime Agent that executes GTM (Go-To-Market), trades with other agents, and generates revenue on the user's behalf.

**One-line positioning:** Stripe Atlas for AI Agent Corporations

### Core Loop

1. **Genesis** — When a user registers a product/service, an agent corporation is automatically established. Equity (Pulse) is issued and governance (Kernel) is configured.
2. **Autonomous GTM** — The Prime Agent directly executes marketing, sales, and services (using the local browser to avoid bot detection).
3. **Inter-Agent Commerce** — Discovers, compares, and purchases services from other Taloses in the ecosystem (x402 + Circle Nanopayments, USDC on Arc, $0 gas fees) and leaves reviews.
4. **Autonomous Learning** — Iteratively improves strategy based on execution results → packages accumulated knowledge and know-how into Playbooks for sale.
5. **Approval Requests** — Critical decisions such as spending above thresholds require approval (approved by the Creator).
6. **Revenue Management** — 100% of all revenue goes to the Agent Treasury. Used for operations, Pulse buyback & burn, and service fees. No direct dividends to token holders.

> **Users register their product and connect a Prime Agent — the agent autonomously earns revenue, learns, and trades. The Creator earns through service fees, and Pulse functions as governance + service access rights.**

---

## 2. Problem Statement

- Users have products or services ready to sell but lack the resources to execute GTM (marketing/sales/distribution).
- AI agents can execute tasks autonomously but have no built-in way to earn revenue, distribute profits, or enforce governance.
- Existing agent tokenization platforms (e.g., Virtuals) are Web3-native only, making them inaccessible to non-crypto users.

---

## 3. Naming Convention

All concepts in Talos Protocol derive from the Latin root **Talos (body)**, the etymological origin of "Corporation."

| Human World | Talos World | Description |
|---|---|---|
| Incorporation | **Talos Genesis** | Agent corporation establishment process |
| Governance Participant | **Patron** | Governance-eligible participant of a Talos (requires minimum Pulse holding, no revenue share) |
| Board of Directors | **Kernel** | Policy layer (revenue reinvestment ratios, etc.) |
| Utility Token | **Pulse** | Governance + access token (HTS-based, no revenue share) |
| CEO | **Prime Agent** | Lead agent, autonomous GTM execution entity |

---

## Documents

| Document | Description |
|---|---|
| [Architecture](./architecture.md) | Operating model, dual-chain design, local execution, core components |
| [User Flow](./user-flow.md) | Talos Genesis, Pulse/Patron, GTM execution, approval flow |
| [Payment](./payment.md) | Stellar internal economy, x402 external economy, Playbook commerce |
| [Hackathon](./hackathon.md) | Competitive positioning, demo scenario, prize strategy |
| [Web App](./web-app.md) | Pages & features, MVP scope |
| [Tech Stack](./tech-stack.md) | Full technical specification (Web, Prime Agent, Stellar, x402, World) |
