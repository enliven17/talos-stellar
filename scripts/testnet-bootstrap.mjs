#!/usr/bin/env node
/**
 * testnet-bootstrap.mjs - one command to stand up a testnet-backed Talos dev
 * environment (issue #1020).
 *
 *   node scripts/testnet-bootstrap.mjs            # run (skips finished steps)
 *   node scripts/testnet-bootstrap.mjs --plan     # show the plan, change nothing
 *   node scripts/testnet-bootstrap.mjs --force    # redo every step
 *
 * Steps, in order: keys -> fund -> trustline -> contracts -> env -> db-migrate
 * -> seed-agents -> mint.
 *
 * Safety rules enforced here:
 *   - testnet only: any other passphrase / mainnet endpoint aborts before work
 *   - secrets live in a 0600 file OUTSIDE the repository, never in stdout
 *   - everything a child process prints is redacted, and any Stellar secret it
 *     emits (e.g. mint-mitos issuer keys) is moved into the 0600 secrets file
 *   - the git-ignored web/.env.local only receives public values unless
 *     --write-operator-secret is passed
 */

import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
export const TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const FRIENDBOT = "https://friendbot.stellar.org";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const LOCAL_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/talos";
export const CLI_IDENTITY = "talos-bootstrap-operator";

export const STEP_IDS = [
  "keys",
  "fund",
  "trustline",
  "contracts",
  "env",
  "db-migrate",
  "seed-agents",
  "mint",
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Network guard ─────────────────────────────────────────────────────────

/**
 * Throws unless every network setting in play points at testnet. Called before
 * any side effect.
 */
export function assertTestnet({ passphrase, horizonUrl, rpcUrl, env = {} } = {}) {
  const pass = passphrase ?? env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE;
  if (pass !== TESTNET_PASSPHRASE) {
    throw new Error(
      `refusing to run: network passphrase is not the Stellar testnet passphrase ("${pass}")`,
    );
  }
  for (const key of ["STELLAR_NETWORK", "NEXT_PUBLIC_STELLAR_NETWORK", "STELLAR_WALLET_NETWORK"]) {
    const v = env[key];
    if (v && !/^testnet$/i.test(v)) {
      throw new Error(`refusing to run: ${key}="${v}" is not testnet`);
    }
  }
  for (const url of [horizonUrl, rpcUrl, env.STELLAR_HORIZON_URL, env.STELLAR_RPC_URL]) {
    if (!url) continue;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`refusing to run: invalid network URL "${url}"`);
    }
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!local && !/(^|[.-])testnet([.-]|$)/.test(host) && !host.endsWith(".stellar.org")) {
      throw new Error(`refusing to run: ${host} does not look like a testnet endpoint`);
    }
    if (/mainnet|public/.test(host) || host === "horizon.stellar.org") {
      throw new Error(`refusing to run: ${host} looks like a mainnet endpoint`);
    }
  }
  return true;
}

// ── Keys (no SDK dependency: ed25519 + Stellar strkey) ─────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16xmodem(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function strkey(versionByte, payload) {
  const body = Buffer.concat([Buffer.from([versionByte]), payload]);
  const crc = crc16xmodem(body);
  const full = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of full) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function keypairFromSeed(seed32) {
  if (seed32.length !== 32) throw new Error("seed must be 32 bytes");
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const priv = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed32]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32);
  return {
    publicKey: strkey(6 << 3, pub), // "G..."
    secret: strkey(18 << 3, seed32), // "S..."
  };
}

export function generateKeypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return keypairFromSeed(der.subarray(der.length - 32));
}

// ── Redaction ──────────────────────────────────────────────────────────────

const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g;

export function findStellarSecrets(text) {
  return [...new Set(String(text).match(STELLAR_SECRET_RE) ?? [])];
}

export function redact(text, extraSecrets = []) {
  let out = String(text).replace(STELLAR_SECRET_RE, "[REDACTED]");
  for (const s of extraSecrets) {
    if (s && s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

/** Redacts the password in a postgres URL so it is safe to show. */
export function redactDatabaseUrl(url) {
  return String(url).replace(/(\/\/[^:/@]+:)[^@]*@/, "$1[REDACTED]@");
}

// ── Storage outside the repo ───────────────────────────────────────────────

export function bootstrapDir(env = process.env) {
  if (env.TALOS_BOOTSTRAP_HOME) return resolve(env.TALOS_BOOTSTRAP_HOME);
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "talos", "testnet-bootstrap");
}

export function assertOutsideRepo(dir, repoRoot = REPO_ROOT) {
  const rel = relative(resolve(repoRoot), resolve(dir));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to store secrets inside the repository (${dir})`);
  }
}

function writePrivate(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* best effort on Windows */
  }
  renameSync(tmp, path);
}

export function loadState(path) {
  if (!existsSync(path)) return { version: 1, steps: {} };
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return { version: 1, steps: {}, ...s };
  } catch {
    throw new Error(`state file ${path} is not valid JSON; fix or delete it to start over`);
  }
}

// ── Step planning (pure) ───────────────────────────────────────────────────

/**
 * Decide, for each step, whether to run or skip it.
 *
 * state: persisted bootstrap state { publicKey?, contracts?, steps: {id: true} }
 * facts: live probes { accountExists, trustlineExists }
 * opts:  { force, skipDb }
 */
export function planSteps({ state, facts, opts = {} }) {
  const done = state.steps ?? {};
  const force = Boolean(opts.force);
  const skip = (id, reason) => ({ id, action: "skip", reason });
  const run = (id, reason) => ({ id, action: "run", reason });

  const plan = [];
  plan.push(
    state.publicKey ? skip("keys", "operator key already exists") : run("keys", "no operator key yet"),
  );
  plan.push(
    facts.accountExists && !force
      ? skip("fund", "operator account already funded")
      : run("fund", "operator account not on testnet yet"),
  );
  plan.push(
    facts.trustlineExists && !force
      ? skip("trustline", "USDC trustline already present")
      : run("trustline", "USDC trustline missing"),
  );
  const c = state.contracts;
  plan.push(
    c?.registry && c?.nameService && !force
      ? skip("contracts", "contracts already deployed")
      : run("contracts", "contracts not deployed"),
  );
  plan.push(done.env && !force ? skip("env", "env file already written") : run("env", "env file not written"));
  for (const id of ["db-migrate", "seed-agents", "mint"]) {
    if (opts.skipDb) plan.push(skip(id, "--skip-db"));
    else plan.push(done[id] && !force ? skip(id, "already completed") : run(id, "not completed yet"));
  }
  return plan;
}

// ── Env file merge ─────────────────────────────────────────────────────────

export function mergeEnv(existing, values) {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      const v = remaining.get(m[1]);
      remaining.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  if (remaining.size) {
    if (out.length) out.push("");
    out.push("# written by scripts/testnet-bootstrap.mjs");
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }
  return out.join("\n") + "\n";
}

export function envValues({ publicKey, contracts, databaseUrl, secret }) {
  const v = {
    STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_STELLAR_NETWORK: "testnet",
    NEXT_PUBLIC_STELLAR_WALLET_NETWORK: "testnet",
    STELLAR_HORIZON_URL: TESTNET_HORIZON,
    STELLAR_RPC_URL: TESTNET_RPC,
    NEXT_PUBLIC_STELLAR_RPC_URL: TESTNET_RPC,
    STELLAR_OPERATOR_PUBLIC_KEY: publicKey,
    NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY: publicKey,
    NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT: contracts.registry,
    NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT: contracts.nameService,
  };
  if (databaseUrl) v.DATABASE_URL = databaseUrl;
  if (secret) v.STELLAR_OPERATOR_SECRET_KEY = secret;
  return v;
}

// ── Real dependencies ──────────────────────────────────────────────────────

function realExec(cmd, args, { env, cwd, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    shell: process.platform === "win32" && cmd === "pnpm",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: 127, output: String(r.error.message) };
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function defaultDeps() {
  return { exec: realExec, fetch: globalThis.fetch, log: (m) => console.log(m), repoRoot: REPO_ROOT };
}

// ── Orchestration ──────────────────────────────────────────────────────────

export async function run(opts = {}, deps = defaultDeps(), env = process.env) {
  const { exec, log, repoRoot } = deps;
  const doFetch = deps.fetch;
  const dir = opts.dir ?? bootstrapDir(env);

  // 1. Network guard and storage guard run before anything else.
  assertTestnet({ passphrase: opts.passphrase, env });
  assertOutsideRepo(dir, repoRoot);

  const statePath = join(dir, "state.json");
  const secretsPath = join(dir, "secrets.env");
  const state = loadState(statePath);
  const databaseUrl = env.DATABASE_URL || LOCAL_DATABASE_URL;
  const usingLocalDb = !env.DATABASE_URL;

  let secret = state.publicKey && existsSync(secretsPath)
    ? /^STELLAR_OPERATOR_SECRET_KEY=(\S+)$/m.exec(readFileSync(secretsPath, "utf8"))?.[1]
    : undefined;
  if (state.publicKey && !secret) {
    throw new Error(`operator key recorded in state but missing from ${secretsPath}; delete ${statePath} to start over`);
  }

  const knownSecrets = () => [secret, ...(state.issuerSecrets ?? [])].filter(Boolean);
  const say = (m) => log(redact(m, knownSecrets()));
  const saveState = () => writePrivate(statePath, JSON.stringify(state, null, 2) + "\n");
  const saveSecrets = () => {
    const lines = [`STELLAR_OPERATOR_SECRET_KEY=${secret}`];
    (state.issuerSecrets ?? []).forEach((s, i) => lines.push(`ISSUER_SECRET_${i + 1}=${s}`));
    writePrivate(secretsPath, lines.join("\n") + "\n");
  };

  const horizonGet = async (path) => {
    const res = await doFetch(`${TESTNET_HORIZON}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon ${path.split("/")[1]} lookup failed: HTTP ${res.status}`);
    return res.json();
  };
  const probe = async () => {
    if (!state.publicKey) return { accountExists: false, trustlineExists: false };
    const acct = await horizonGet(`/accounts/${state.publicKey}`);
    return {
      accountExists: Boolean(acct),
      trustlineExists: Boolean(
        acct?.balances?.some((b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER),
      ),
    };
  };

  let facts = await probe();
  const plan = planSteps({ state, facts, opts });

  log("Talos testnet bootstrap (testnet only)");
  for (const s of plan) log(`  ${s.action === "run" ? "run " : "skip"}  ${s.id.padEnd(12)} ${s.reason}`);
  if (opts.plan) return { plan, ran: [] };

  const child = (cmd, args, extra = {}) => {
    const r = exec(cmd, args, { cwd: repoRoot, ...extra });
    // Anything that looks like a Stellar secret goes to the 0600 file, never stdout.
    const found = findStellarSecrets(r.output).filter((s) => s !== secret);
    if (found.length) {
      state.issuerSecrets = [...new Set([...(state.issuerSecrets ?? []), ...found])];
      saveSecrets();
      saveState();
    }
    const text = redact(r.output, knownSecrets()).trim();
    if (text) log(text.split("\n").map((l) => `    ${l}`).join("\n"));
    return r;
  };
  const childEnv = () => ({ STELLAR_OPERATOR_SECRET_KEY: secret, DATABASE_URL: databaseUrl });
  const fail = (id, msg) => {
    throw new Error(`step "${id}" failed: ${msg}`);
  };
  const ran = [];

  for (const step of plan) {
    if (step.action === "skip") continue;
    log(`\n> ${step.id}`);

    if (step.id === "keys") {
      const kp = generateKeypair();
      secret = kp.secret;
      state.publicKey = kp.publicKey;
      state.issuerSecrets = state.issuerSecrets ?? [];
      saveSecrets();
      state.steps = {};
      state.contracts = undefined;
      saveState();
      log(`  operator public key: ${state.publicKey}`);
      log(`  secret stored in ${secretsPath} (mode 0600)`);
    }

    if (step.id === "fund") {
      const res = await doFetch(`${FRIENDBOT}?addr=${encodeURIComponent(state.publicKey)}`);
      if (!res.ok && res.status !== 400) fail("fund", `Friendbot returned HTTP ${res.status}`);
      facts = await probe();
      if (!facts.accountExists) fail("fund", "account still not found on Horizon after Friendbot");
      log("  funded via Friendbot");
    }

    if (step.id === "trustline") {
      const r = child("pnpm", ["--dir", "web", "exec", "tsx", "scripts/add-usdc-trustline.ts"], {
        env: childEnv(),
      });
      // The helper swallows its own errors, so verify against the network.
      facts = await probe();
      if (r.status !== 0 || !facts.trustlineExists) fail("trustline", "USDC trustline was not created");
    }

    if (step.id === "contracts") {
      const have = exec("stellar", ["--version"], {});
      if (have.status !== 0) fail("contracts", "the Stellar CLI (`stellar`) is not installed or not on PATH");
      // Secret goes to the CLI via stdin, not argv.
      const add = exec("stellar", ["keys", "add", CLI_IDENTITY, "--secret-key"], { input: `${secret}\n` });
      if (add.status !== 0 && !/already exists/i.test(add.output)) {
        fail("contracts", redact(add.output, knownSecrets()).trim() || "could not register the key with the Stellar CLI");
      }
      const r = child("bash", ["contracts/deploy.sh", "testnet", "--source", CLI_IDENTITY], {});
      const registry = /NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=(C[A-Z2-7]{55})/.exec(r.output)?.[1];
      const nameService = /NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=(C[A-Z2-7]{55})/.exec(r.output)?.[1];
      if (r.status !== 0 || !registry || !nameService) fail("contracts", "deploy.sh did not report both contract ids");
      state.contracts = { registry, nameService };
      state.steps.contracts = true;
      saveState();
    }

    if (step.id === "env") {
      if (!state.contracts) fail("env", "contract ids are not known yet");
      const envPath = join(repoRoot, "web", ".env.local");
      const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
      const values = envValues({
        publicKey: state.publicKey,
        contracts: state.contracts,
        databaseUrl: usingLocalDb ? databaseUrl : undefined,
        secret: opts.writeOperatorSecret ? secret : undefined,
      });
      writePrivate(envPath, mergeEnv(existing, values));
      log(`  wrote ${relative(repoRoot, envPath)} (git-ignored, public values${opts.writeOperatorSecret ? " + operator secret" : " only"})`);
      if (!opts.writeOperatorSecret) {
        log(`  operator secret is in ${secretsPath}; re-run with --write-operator-secret to add it to .env.local`);
      }
      if (!usingLocalDb) log(`  DATABASE_URL taken from your environment (${redactDatabaseUrl(databaseUrl)}), not written to the file`);
    }

    if (step.id === "db-migrate") {
      const r = child("pnpm", ["--dir", "web", "run", "db:migrate"], { env: childEnv() });
      if (r.status !== 0) fail("db-migrate", `could not migrate ${redactDatabaseUrl(databaseUrl)} (is the database running? try: pnpm stack:up)`);
    }
    if (step.id === "seed-agents") {
      const r = child("pnpm", ["--dir", "web", "run", "db:seed-demo"], { env: childEnv() });
      if (r.status !== 0) fail("seed-agents", "db:seed-demo failed");
    }
    if (step.id === "mint") {
      const r = child("pnpm", ["--dir", "web", "exec", "tsx", "scripts/mint-mitos.ts"], { env: childEnv() });
      if (r.status !== 0) fail("mint", "mint-mitos failed");
    }

    if (step.id !== "keys" && step.id !== "fund" && step.id !== "trustline") state.steps[step.id] = true;
    saveState();
    ran.push(step.id);
  }

  log("\nDone. Start the app with: pnpm dev");
  return { plan, ran };
}

// ── CLI ────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {};
  for (const a of argv) {
    if (a === "--plan" || a === "--dry-run") opts.plan = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--skip-db") opts.skipDb = true;
    else if (a === "--write-operator-secret") opts.writeOperatorSecret = true;
    else if (a.startsWith("--network-passphrase=")) opts.passphrase = a.split("=").slice(1).join("=");
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

const HELP = `Usage: node scripts/testnet-bootstrap.mjs [options]

  --plan                    show what would run, change nothing
  --force                   redo every step except key generation
  --skip-db                 skip db-migrate, seed-agents and mint
  --write-operator-secret   also put the operator secret in web/.env.local

Env: DATABASE_URL (default ${redactDatabaseUrl(LOCAL_DATABASE_URL)}), TALOS_BOOTSTRAP_HOME
Testnet only. Secrets are kept in a 0600 file outside the repository.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    try {
      const opts = parseArgs(process.argv.slice(2));
      if (opts.help) {
        console.log(HELP);
        return;
      }
      await run(opts);
    } catch (e) {
      console.error(`testnet-bootstrap: ${redact(e instanceof Error ? e.message : e)}`);
      process.exit(1);
    }
  })();
}
