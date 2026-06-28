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

