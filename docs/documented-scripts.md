# Documented scripts

`scripts/check-documented-scripts.mjs` reads the repository's Markdown docs and
verifies that every documented npm or pnpm script exists in the relevant
`package.json`. It only reads local files: it never contacts a package registry
and never executes the documented commands.

Run it from the repository root:

```bash
pnpm run docs:scripts:check
pnpm run docs:scripts:check -- --verbose
pnpm run docs:scripts:check -- --json
pnpm run test:docs-scripts
```

## What is checked

The checker scans `README.md`, `CONTRIBUTING.md`, and `docs/**/*.md`. Commands
inside fenced code blocks and inline code spans are checked; prose is ignored.
It recognises these forms:

- `npm run <script>`, `npm run-script <script>`, and the npm `test` shorthand
- `pnpm run <script>`, `pnpm <script>`, and the pnpm `test` shorthand
- `pnpm --dir <path> run <script>` and `pnpm --dir <path> <script>`
- `pnpm --filter <workspace> run <script>` and `pnpm --filter <workspace> <script>`
- `cd <path>` followed by one of the forms above in the same fenced block

Package-manager builtins (`pnpm install`, `pnpm exec`, `npm ci`, and similar)
and placeholders such as `pnpm run <script>` are ignored. Version text like
`pnpm 9` is ignored too.

## How a script is resolved

1. An explicit `--dir` or `--filter` selects that workspace. A missing script
   or unknown workspace is reported.
2. Otherwise the command uses the working directory, including `cd` lines
   earlier in the same fenced block.
3. If the script is not in that package but exactly one workspace provides it,
   the unique match is accepted and shown as `unique workspace match` in
   `--verbose` output.
4. For inline commands, a workspace path on the same line (for example
   `` `packages/sdk` ``) resolves the command when the root package does not
   provide it.
5. If the script is still missing, the checker reports the file, line, command,
   and package.

A bare script that exists in several workspaces is not guessed; the docs must
use `--dir` or `--filter` to make the target explicit.

## Fixing a failure

- If the command is wrong, update the doc to the real script name or add the
  missing `--dir`/`--filter`.
- If the script is genuinely missing, add it to the package's `package.json`
  or remove the documented command.
- Run `pnpm run docs:scripts:check` again and confirm it reports
  `OK: every documented npm/pnpm script exists.`
