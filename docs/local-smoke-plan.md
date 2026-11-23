# Local smoke plan

`scripts/local-smoke-plan.mjs` turns a set of changed files into the exact
commands a contributor should run before opening a pull request. It is
deterministic and offline: it prints commands, and never installs packages,
reads environment files, uses credentials, or contacts remote services.

Run it from the repository root:

```bash
# Compare the working tree and untracked files against HEAD
pnpm run smoke:plan

# Compare a branch against its base
pnpm run smoke:plan --base origin/main

# Plan an explicit path (repeatable or comma-separated)
pnpm run smoke:plan --file web/src/app/page.tsx
pnpm run smoke:plan --file web/src/app/page.tsx,packages/sdk/src/client.ts

# Plan everything, or emit JSON for tooling
pnpm run smoke:plan --all
pnpm run smoke:plan --json
```

The script only inspects file paths. It never opens changed files, so values
from `.env` files, credentials, and payment proofs cannot appear in its output.

## Classification

| Changed path | Plan |
| --- | --- |
| `web/**` | Web commands |
| `packages/sdk/**` | SDK commands |
| `packages/prime-agent/**` | Prime agent commands |
| `contracts/**` | Contract commands |
| `contracts/package.json` | Shared toolchain: root + every workspace |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `justfile`, `compatibility.json` | Shared toolchain: root + every workspace |
| `.github/**`, `.devcontainer/**`, `scripts/**` | Shared toolchain: root + every workspace |
| `docs/**`, root Markdown docs | Documentation only: no workspace commands |
| `.env`, `.env.*` | Environment only: no workspace commands; values are never read |
| Anything else | Unknown: fails closed to root + every workspace |

The commands mirror the `justfile` recipes (`just test-web`, `just test-sdk`,
`just test-agent`, `just test-contracts`), so the plan and local CI stay in
sync.

## Changing the plan

- Add or update commands in `WORKSPACE_COMMANDS` in
  `scripts/local-smoke-plan.mjs`.
- Keep commands runnable from the repository root.
- Update `scripts/local-smoke-plan.test.mjs` when you add a workspace or change
  the classification rules.
- Run `pnpm run test:smoke-plan` before committing.
