Resources
There are a number of emerging payment systems designed for the agentic economy. These include but are not limited to:

x402 is a pay-per-request settlement protocol backed by Coinbase. Stellar docs: https://developers.stellar.org/docs/build/agentic-payments/x402
MPP, backed by Stripe, can do pay-per-request (Charge intent) or high-frequency pay-as-you-go via payment channels (Session intent). Stellar docs: https://developers.stellar.org/docs/build/agentic-payments/mpp
x402 is fully integrated on Stellar and the main repo includes tools, examples, and references: https://github.com/stellar/x402-stellar
There is a quickstart tutorial showing how to setup a x402 server and client here: https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide
This guide includes information on how to generate wallets using Stellar Lab and fund them with testnet funds (XLM and USDC). There are some test services you can play with using your testnet funds at https://xlm402.com which also serves as an open-source example.
A demo MCP server is available which enables agents to pay for x402 services on Stellar testnet and mainnet using Claude Code, Codex or any other MCP-enabled AI system: https://github.com/jamesbachini/x402-mcp-stellar
Stellar Dev Tools
Stellar Docs: https://developers.stellar.org/ Core documentation for building on Stellar (concepts, APIs, smart contracts, and guides).
SDKs: https://developers.stellar.org/docs/tools/sdks Libraries + docs to interact with the network and build apps in your preferred language.
Stellar CLI: https://developers.stellar.org/docs/tools/cli Build, deploy, and interact with Stellar smart contracts from the command line.
Lab: https://developers.stellar.org/docs/tools/lab Explore, test, and experiment with Stellar developer tools and APIs in the browser.
Quickstart: https://developers.stellar.org/docs/tools/quickstart Run a local Stellar network environment via Docker for development/testing.
Stellar Wallets Kit: https://stellarwalletskit.dev/ Plug-and-play wallet connections for Stellar apps with a simple unified API.
Scaffold Stellar: https://scaffoldstellar.org CLI tool for the full Stellar app development lifecycle — smart contract management, testing, and deployment with best practices baked in.
x402 / Agentic Payments
x402
x402 on Stellar — Docs: https://developers.stellar.org/docs/build/agentic-payments/x402 Per-request HTTP payment protocol for AI agents. Client hits a paywalled endpoint, receives a 402, signs a Soroban auth entry, and retries with payment.
Built on Stellar x402 Facilitator: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar The facilitator service that processes x402 payments on Stellar (powered by OpenZeppelin Relayer).
x402 Quickstart Guide: https://developers.stellar.org/docs/build/agentic-payments/x402/quickstart-guide Step-by-step guide to setting up an x402 server and client on Stellar.
x402 Demo on Stellar: https://stellar.org/x402-demo Live demo showing the x402 payment flow end-to-end on Stellar Testnet or Mainnet.
x402 Facilitator Supported Networks: https://www.x402.org/facilitator/supported Lists supported networks (including stellar:testnet) and facilitator configuration options.
OpenZeppelin x402 Facilitator Plugin: https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator Run your own x402 facilitator on testnet or mainnet via the OZ Relayer. Exposes /verify, /settle, and /supported endpoints.
OpenZeppelin x402 Facilitator Docs: https://docs.openzeppelin.com/relayer/1.4.x/guides/stellar-x402-facilitator-guide
x402 Compatible Wallets: To support x402 on Stellar, a wallet must support auth-entry signing. Compatible wallets: Freighter (browser extension), Albedo, Hana, HOT, Klever, OneKey. Note: Freighter mobile does not currently support x402.
Stellar Observatory: https://github.com/elliotfriend/stellar-observatory Get the latest space weather conditions with x402 on Stellar. Works on testnet and mainnet, and includes an MCP server. Live app: https://stellar-observatory.vercel.app
Stellar Sponsored Agent Account: https://github.com/oceans404/stellar-sponsored-agent-account Gives any AI agent a Stellar USDC wallet in less than a minute, without needing any XLM to start. Uses Stellar's native sponsorship protocol to cover the ~1.5 XLM account setup cost. Try it — tell Claude or your agent: Create a Stellar account for USDC. Skill: https://stellar-sponsored-agent-account.onrender.com/SKILL.md
x402 Starter Template: https://github.com/ElliotFriend/x402/tree/stellar-browser-wallet-example/examples/typescript/fullstack/browser-wallet-example Scaffolding with browser wallet support — a good starting point for micropayment-enabled services or SaaS apps.
1-shot Stellar x402 app: https://github.com/oceans404/1-shot-stellar/tree/main/x402-app Video paywall example with a guide for building payment-enabled apps on Stellar.
Economic Load Balancer: https://github.com/marcelosalloum/x402/tree/x402-hackathon Intelligent multi-chain payment router that automatically selects the most cost-efficient network for AI agent micropayments.
MPP
MPP on Stellar — Docs: https://developers.stellar.org/docs/build/agentic-payments/mpp Overview of both MPP payment intents on Stellar.
MPP Charge Guide: https://developers.stellar.org/docs/build/agentic-payments/mpp/charge-guide Getting started with one-off per-request payments using pull or push credential modes.
MPP Session Guide: https://developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide High-frequency off-chain payments via unidirectional payment channels — no per-payment on-chain transactions, ideal for AI agent interactions.
MPP Demo: https://mpp.stellar.buzz Live demo running a Node.js server charging 0.01 USDC per request on Stellar Testnet.
one-way-channel contract: https://github.com/stellar-experimental/one-way-channel The Soroban contract powering MPP's Session (channel) mode.
Repos / SDKs
stellar/x402-stellar: https://github.com/stellar/x402-stellar Official monorepo — facilitator service, simple-paywall demo (Express + React), Heroku deployment config, and channel account setup.
x402-stellar (npm): https://www.npmjs.com/package/x402-stellar npm package for integrating x402 payments into your Stellar app.
coinbase/x402: https://github.com/coinbase/x402 Official x402 protocol GitHub repo from Coinbase.
stellar/stellar-mpp-sdk: https://github.com/stellar/stellar-mpp-sdk Official MPP SDK — source, examples, and integration tests.
@stellar/mpp (npm): https://www.npmjs.com/package/@stellar/mpp npm package for MPP on Stellar (install alongside mppx and @stellar/stellar-sdk).
mppx (npm): https://www.npmjs.com/package/mppx Core MPP framework library.
stripe-samples/machine-payments: https://github.com/stripe-samples/machine-payments Stripe's reference implementation for machine-to-machine payments.
Protocol References
Coinbase x402 Docs: https://docs.cdp.coinbase.com/x402/docs/welcome Coinbase's documentation for the x402 protocol.
x402 Protocol: https://www.x402.org/ The x402 protocol specification.
MPP Protocol Spec: https://mpp.dev The official MPP protocol specification.
Stripe Machine Payments: https://stripe.com/blog/machine-payments-protocol Stripe's machine payments product page.
Stripe MPP Docs: https://docs.stripe.com/payments/machine Documentation for Stripe's machine-payable payments integration.
Stripe MPP Quickstart: https://docs.stripe.com/payments/machine/mpp/quickstart Get started with Stripe machine payments in minutes.
Helpful Stellar Building Blocks
Contract Accounts: https://developers.stellar.org/docs/build/guides/contract-accounts How contract accounts work on Stellar — essential for x402 facilitator patterns.
Contract Authorization: https://developers.stellar.org/docs/learn/fundamentals/contract-development/authorization Soroban's authorization model — required reading for signing auth entries in x402 flows.
Signing Soroban Invocations: https://developers.stellar.org/docs/build/guides/transactions/signing-soroban-invocations Auth-entry signing and transaction signing on Stellar — relevant to both x402 and MPP flows.
Anchor Integration Starter Pack
Anchor starter pack (code): https://github.com/ElliotFriend/regional-starter-pack SvelteKit reference app with a portable TypeScript anchor library. The /src/lib/anchors/ folder is framework-agnostic — copy it into any TypeScript or Node project. Includes client implementations for Etherfuse, AlfredPay, and BlindPay. Implements SEP-1, SEP-6, SEP-10, SEP-12, SEP-24, SEP-31, and SEP-38. Ships with pre-configured MCP servers for Claude Code. A good starting point for any fiat on/off-ramp integration.
Reference Implementations (Code)
Ya Otter Save (fiat savings flow): https://github.com/briwylde08/ya-otter-save Complete testnet demo: fiat on-ramp → stablebonds → Stellar DEX swap → USDC → Blend deposit (yield), with the reverse path for withdrawal. TypeScript/Next.js. Shows how Etherfuse, the Stellar DEX, and Blend compose end-to-end.
Stellar DeFi App (mainnet dashboard): https://github.com/kaankacar/stellar-defi-app Full DeFi dashboard integrating Blend, Soroswap, Phoenix, Aquarius, SDEX, and Reflector Oracle. Most useful for seeing how protocols compose — actual API call shapes, response formats, and wiring.
AI Freighter Integration: https://github.com/carstenjacobsen/ai-freighter-integration Freighter wallet connection, XLM balance display, send payments, transaction history. Next.js + TypeScript. Includes BUILD_REPORT.md.
AI Soroswap Integration: https://github.com/carstenjacobsen/ai-soroswap-integration Multi-DEX swap aggregator routing across Soroswap, Phoenix, Aqua, and SDEX simultaneously.
AI DeFindex Integration: https://github.com/carstenjacobsen/ai-defindex-integration DeFindex yield vault deposits/withdrawals and dfToken balance tracking.
AI Passkeys Integration: https://github.com/carstenjacobsen/ai-passkeys-integration WebAuthn passkey smart wallet with Etherfuse fiat on/off-ramp.
AI Etherfuse Integration: https://github.com/carstenjacobsen/ai-etherfuse-integration Full Etherfuse ramp integration combined with DeFindex yield and Freighter wallet in a single three-tab app.
x402 Community Demo (jamesbachini): https://github.com/jamesbachini/x402-Stellar-Demo Minimal local demo showing payer client + protected Express server + local facilitator. Good for understanding the x402 flow end-to-end.
AI Development Assistance
Stellar Dev Skills: https://github.com/stellar/stellar-dev-skill AI skill for modern Stellar development — covers Soroban, SDKs, RPC, wallet integration, passkeys, and security patterns. Invoke with stellar-dev:stellar-dev in Claude Code.
OpenZeppelin Skills: https://github.com/OpenZeppelin/openzeppelin-skills Claude Code skills for secure Stellar contract development. Install: /plugin marketplace add OpenZeppelin/openzeppelin-skills. Includes an MCP server for AI-assisted contract generation.
llms.txt: https://developers.stellar.org/llms.txt Machine-readable Stellar docs digest designed for feeding into any LLM.
Smart Account Kit: https://github.com/kalepail/smart-account-kit TypeScript SDK for building passkey smart wallets on Soroban — createWallet, connectWallet, signAndSubmit, gasless tx via OZ Relayer.
Stellar MCP Server: https://github.com/kalepail/stellar-mcp-server MCP server exposing Stellar wallet, token, and contract tools to Claude and other AI clients.
XDR MCP: https://github.com/stellar-experimental/mcp-stellar-xdr MCP server that decodes and encodes Stellar XDR to/from JSON for AI agents.
OpenZeppelin on Stellar: https://www.openzeppelin.com/networks/stellar Audited contract library, Contracts Wizard, Contracts MCP server, Relayer, Monitor, and Soroban Security Detectors SDK.
Free AI Setup
Full guide with local models, free cloud APIs, and VPS rental: https://github.com/kaankacar/stellar-ai-guide-mx/blob/main/Free_AI_Setup.md Covers Ollama + Claude Code setup, free cloud options (OpenRouter, Groq, Mistral Codestral, Google AI Studio), and GPU rental on RunPod/Vast.ai for a few dollars.
Community Resources
Stellar Hackathon FAQ: https://github.com/briwylde08/stellar-hackathon-faq Community-compiled FAQ from building with anchors and DeFi protocols.
Stellar DeFi Gotchas: https://github.com/kaankacar/stellar-defi-gotchas 400+ findings from 60 vibe-coding runs, organized by protocol.
Stellar Ecosystem DB: https://github.com/lumenloop/stellar-ecosystem-db Structured database of 646 Stellar projects with categories, contracts, and GitHub links. Useful for finding existing work before building from scratch.
Stellar Ecosystem Resources: https://github.com/stellar/ecosystem-resources/ Workshop activations, reference guides for Soroban, wallet integration, DeFi protocols, OpenZeppelin, tokens, and security.