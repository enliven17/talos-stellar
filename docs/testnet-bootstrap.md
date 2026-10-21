# Testnet bootstrap

`pnpm testnet:bootstrap` (`scripts/testnet-bootstrap.mjs`) stands up a working testnet-backed
environment in one command. It replaces the manual sequence of `contracts/deploy.sh`, copying
contract ids into `.env.local`, Friendbot funding, `add-usdc-trustline.ts`, `db:seed-demo` and
`mint-mitos.ts`.

## Prerequisites

- Node 20+, `pnpm`, and `pnpm web:install` already run
- Rust + the `wasm32-unknown-unknown` target, and the Stellar CLI (`stellar`) for contract deployment
- `bash` (Git Bash on Windows) because `contracts/deploy.sh` is a shell script
- A reachable Postgres: `pnpm stack:up` starts the local one, or export `DATABASE_URL`

## Usage

```bash
pnpm testnet:bootstrap                         # run; finished steps are skipped
pnpm testnet:bootstrap -- --plan               # show what would run, change nothing
pnpm testnet:bootstrap -- --skip-db            # chain-side steps only
pnpm testnet:bootstrap -- --force              # redo every step (keeps the operator key)
pnpm testnet:bootstrap -- --write-operator-secret
```

## Steps

| Step | What it does | Skipped when |
| --- | --- | --- |
| `keys` | Generates a throwaway operator keypair | a key already exists |
| `fund` | Funds the operator via Friendbot | the account already exists on Horizon |
| `trustline` | Adds the USDC trustline (`add-usdc-trustline.ts`) | the trustline already exists on Horizon |
| `contracts` | Deploys registry + name service via `contracts/deploy.sh` | both contract ids are recorded |
| `env` | Writes `web/.env.local` (merged, other values kept) | already written |
| `db-migrate` | `pnpm --dir web db:migrate` | already completed |
| `seed-agents` | `pnpm --dir web db:seed-demo` | already completed |
| `mint` | `mint-mitos.ts` | already completed |

Progress is kept in `state.json`, so an interrupted run resumes at the step that failed.

## Safety

- **Testnet only.** Any other network passphrase, a non-testnet `STELLAR_NETWORK`, or a mainnet
  endpoint aborts before any work is done.
- **Secrets stay out of the repo and out of stdout.** The operator secret, and any issuer secrets
  printed by `mint-mitos.ts`, are written to `secrets.env` (mode 0600) in
  `~/.config/talos/testnet-bootstrap/` (override with `TALOS_BOOTSTRAP_HOME`). The script refuses
  to use a directory inside the repository. Child-process output is redacted before it is shown.
- **`web/.env.local` is git-ignored and holds public values only** (public key, contract ids, network
  URLs) unless you pass `--write-operator-secret`. Server-side signing needs
  `STELLAR_OPERATOR_SECRET_KEY`, so add it with that flag, or copy it from `secrets.env`.
- The operator secret reaches child processes through environment variables or stdin, never argv.
- `DATABASE_URL` from your environment is used for the database steps but is not copied to the file.

## Tests

```bash
pnpm test:testnet-bootstrap
```

Covers the network guard, step planning (fresh, finished, partial and forced states), key encoding
against Stellar SDK vectors, redaction, env merging, and an end-to-end run against a fake chain
and fake child processes (including "re-run does nothing" and "nothing secret on stdout").
