This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## OpenAPI Contract

The public API spec lives in `src/lib/openapi.ts` and is served at `/api/docs/openapi.json`.

When an API route request or response shape changes:

1. Update `src/lib/openapi.ts`, including `info.version` for public contract changes.
2. Regenerate the checked-in snapshot:

```bash
pnpm openapi:snapshot
```

3. Run the drift check:

```bash
pnpm test:openapi
```

CI runs the same snapshot test and fails if `/api/docs/openapi.json` differs from `tests/fixtures/openapi.snapshot.json`.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Real-time Events (SSE)

`GET /api/events?wallet=<G…>` streams Server-Sent Events to dashboard clients.

### How it works

1. On connect, the server resolves all TALOS IDs for the wallet (2 DB queries, cached for the connection lifetime).
2. Every 8 s it polls for new approvals and activities (2 DB queries per poll).
3. Every 30 s it sends a `ping` event that doubles as a zombie-connection probe — if the write fails, the connection slot is released immediately.

**DB query budget:** 2 (init) + 2 per 8 s poll, per connection.  
At 50 concurrent users: ~750 queries/min → **~150 queries/min** (5× reduction vs. the original per-tick lookup).

### Connection cap

The server rejects connections beyond `SSE_MAX_CONNECTIONS` (default `200`) with `503 Service Unavailable` + `Retry-After: 10`.

```
SSE_MAX_CONNECTIONS=100   # tune per deployment
```

The cap is enforced per-process. On multi-container deployments each container maintains its own count independently.

### Deployment trade-offs

| Deployment | Behaviour | Recommendation |
|---|---|---|
| **Vercel Hobby** | 60 s function timeout — stream is killed and the browser reconnects | Use short-poll (Option B) |
| **Vercel Pro** | 300 s timeout — marginally better but still limits session length | Evaluate Fluid Compute (beta) or Option A |
| **Railway / Fly.io** | No function timeout — connections live indefinitely | Recommended for production at scale |

**Option A — persistent service (best real-time fidelity)**  
Move only this endpoint to a long-running container on Railway or Fly.io (~$5–10/mo for 512 MB). The rest of the Next.js app stays on Vercel.

**Option B — short-poll + ETag (simplest, zero extra infra)**  
Replace with `GET /api/events/poll` that returns `304 Not Modified` when nothing has changed. Clients poll every 10–15 s. Slightly lower real-time fidelity but fully serverless-compatible and eliminates the connection-count problem entirely.

### Metrics

`getSseMetrics()` (exported from `src/app/api/events/route.ts`) returns:

```ts
{ activeConnections: number; totalDbQueries: number }
```

Wire this into `/api/health` or a dedicated `/api/metrics` endpoint for monitoring.

---

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Environment Variables on Vercel

When deploying this application on Vercel, make sure the following Stellar environment variables are properly configured in your Vercel Project Settings:

### Server-Side Variables (Hidden from browser)
* `STELLAR_OPERATOR_SECRET_KEY`: The operator treasury secret key (starts with `S`), used for signing transactions.
* `STELLAR_OPERATOR_PUBLIC_KEY`: The operator treasury public key (starts with `G`), used for server-side auth validation.
* `STELLAR_NETWORK`: Network to use (`testnet` or `mainnet`).
* `STELLAR_HORIZON_URL`: URL of the Stellar Horizon server.
* `STELLAR_RPC_URL`: URL of the Soroban RPC server.
* `STELLAR_USDC_ISSUER`: USDC token issuer public key.

### Client-Side Variables (Prefix `NEXT_PUBLIC_`, exposed to browser)
* `NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY`: The operator treasury public key (starts with `G`).
* `NEXT_PUBLIC_STELLAR_NETWORK`: Network to use (`testnet` or `mainnet`).
* `NEXT_PUBLIC_STELLAR_RPC_URL`: URL of the Soroban RPC server.
* `NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT`: The registry Soroban contract ID.
* `NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT`: The name service Soroban contract ID.
* `NEXT_PUBLIC_STELLAR_WALLET_NETWORK`: Wallet network setting (e.g. `testnet`).
* `NEXT_PUBLIC_TALOS_CREATION_XLM`: XLM required for Talos creation.
* `NEXT_PUBLIC_STELLAR_USDC_ISSUER`: USDC token issuer public key.

