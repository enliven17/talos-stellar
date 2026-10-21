import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TESTNET_PASSPHRASE,
  USDC_ISSUER,
  assertOutsideRepo,
  assertTestnet,
  envValues,
  generateKeypair,
  keypairFromSeed,
  mergeEnv,
  parseArgs,
  planSteps,
  redact,
  redactDatabaseUrl,
  run,
} from "./testnet-bootstrap.mjs";

const REGISTRY = "C" + "A".repeat(55);
const NAME_SERVICE = "C" + "B".repeat(55);
// A Stellar-shaped secret that a child process might print (e.g. mint-mitos issuer keys).
const ISSUER_SECRET = "SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X"; // gitleaks:allow (public SDK test vector)

// ── network guard ───────────────────────────────────────────────────────────

test("guard accepts the testnet passphrase and endpoints", () => {
  assert.equal(
    assertTestnet({
      passphrase: TESTNET_PASSPHRASE,
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
      env: { STELLAR_NETWORK: "testnet" },
    }),
    true,
  );
});

test("guard refuses the public/mainnet passphrase", () => {
  assert.throws(
    () => assertTestnet({ passphrase: "Public Global Stellar Network ; September 2015" }),
    /not the Stellar testnet passphrase/,
  );
});

test("guard refuses a mainnet passphrase supplied via env", () => {
  assert.throws(
    () => assertTestnet({ env: { STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015" } }),
    /not the Stellar testnet passphrase/,
  );
});

test("guard refuses a non-testnet STELLAR_NETWORK", () => {
  for (const v of ["mainnet", "public", "PUBLIC"]) {
    assert.throws(() => assertTestnet({ env: { STELLAR_NETWORK: v } }), /not testnet/);
  }
});

test("guard refuses mainnet endpoints", () => {
  assert.throws(() => assertTestnet({ horizonUrl: "https://horizon.stellar.org" }), /mainnet/);
  assert.throws(() => assertTestnet({ rpcUrl: "https://soroban-mainnet.stellar.org" }), /mainnet/);
  assert.throws(() => assertTestnet({ rpcUrl: "https://example.com/rpc" }), /does not look like a testnet/);
  assert.throws(() => assertTestnet({ rpcUrl: "not a url" }), /invalid network URL/);
});

test("run() aborts on a mainnet passphrase before any side effect", async () => {
  const calls = [];
  const deps = {
    exec: (...a) => (calls.push(a), { status: 0, output: "" }),
    fetch: async (...a) => (calls.push(a), { ok: true, status: 200, json: async () => ({}) }),
    log: () => {},
    repoRoot: "/repo",
  };
  await assert.rejects(
    run({ dir: mkdtempSync(join(tmpdir(), "tb-")), passphrase: "Public Global Stellar Network ; September 2015" }, deps, {}),
    /not the Stellar testnet passphrase/,
  );
  assert.equal(calls.length, 0);
});

// ── step planning ───────────────────────────────────────────────────────────

const fresh = { state: { steps: {} }, facts: { accountExists: false, trustlineExists: false } };
const finished = {
  state: {
    publicKey: "G" + "A".repeat(55),
    contracts: { registry: REGISTRY, nameService: NAME_SERVICE },
    steps: { env: true, "db-migrate": true, "seed-agents": true, mint: true },
  },
  facts: { accountExists: true, trustlineExists: true },
};
const actions = (plan) => Object.fromEntries(plan.map((s) => [s.id, s.action]));

test("a fresh environment plans every step, in order", () => {
  const plan = planSteps(fresh);
  assert.deepEqual(plan.map((s) => s.id), ["keys", "fund", "trustline", "contracts", "env", "db-migrate", "seed-agents", "mint"]);
  assert.ok(plan.every((s) => s.action === "run"));
});

test("a finished environment skips every step", () => {
  assert.ok(planSteps(finished).every((s) => s.action === "skip"));
});

test("only the missing piece is re-run (trustline gone)", () => {
  const plan = actions(planSteps({ ...finished, facts: { accountExists: true, trustlineExists: false } }));
  assert.equal(plan.trustline, "run");
  assert.equal(plan.fund, "skip");
  assert.equal(plan.contracts, "skip");
});

test("partial state: contracts deployed but env not written", () => {
  const state = { ...finished.state, steps: {} };
  const plan = actions(planSteps({ state, facts: finished.facts }));
  assert.equal(plan.contracts, "skip");
  assert.equal(plan.env, "run");
  assert.equal(plan.mint, "run");
});

test("one deployed contract is not enough to skip deployment", () => {
  const state = { ...finished.state, contracts: { registry: REGISTRY } };
  assert.equal(actions(planSteps({ state, facts: finished.facts })).contracts, "run");
});

test("--force reruns everything except key generation", () => {
  const plan = actions(planSteps({ ...finished, opts: { force: true } }));
  assert.equal(plan.keys, "skip");
  assert.ok(Object.entries(plan).filter(([k]) => k !== "keys").every(([, v]) => v === "run"));
});

test("--skip-db skips the database steps", () => {
  const plan = actions(planSteps({ ...fresh, opts: { skipDb: true } }));
  assert.equal(plan["db-migrate"], "skip");
  assert.equal(plan["seed-agents"], "skip");
  assert.equal(plan.mint, "skip");
  assert.equal(plan.fund, "run");
});

// ── keys, redaction, env, storage ───────────────────────────────────────────

test("keypair encoding matches the Stellar SDK reference vectors", () => {
  const a = keypairFromSeed(Buffer.alloc(32, 7));
  assert.equal(a.publicKey, "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57");
  assert.equal(a.secret, ISSUER_SECRET);
  const b = keypairFromSeed(Buffer.from(Array.from({ length: 32 }, (_, i) => i)));
  assert.equal(b.publicKey, "GAB2CB576PHBBPQ5ODORRZ2LYCMWPZGWGCN2KDK7DXOIMZASKUY3QZ6Q");
  assert.equal(b.secret, "SAAACAQDAQCQMBYIBEFAWDANBYHRAEISCMKBKFQXDAMRUGY4DUPB6NKI"); // gitleaks:allow (public SDK test vector)
});

test("generated keys have the right shape and are unique", () => {
  const a = generateKeypair();
  const b = generateKeypair();
  assert.match(a.publicKey, /^G[A-Z2-7]{55}$/);
  assert.match(a.secret, /^S[A-Z2-7]{55}$/);
  assert.notEqual(a.secret, b.secret);
});

test("redact removes Stellar secrets and known strings, keeps public keys", () => {
  const pub = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
  const out = redact(`key ${ISSUER_SECRET} pub ${pub} pw hunter2hunter2`, ["hunter2hunter2"]);
  assert.ok(!out.includes(ISSUER_SECRET));
  assert.ok(!out.includes("hunter2hunter2"));
  assert.ok(out.includes(pub));
  assert.equal(redactDatabaseUrl("postgresql://u:secretpw@host:5432/db"), "postgresql://u:[REDACTED]@host:5432/db");
});

test("mergeEnv updates managed keys, preserves the rest, appends new ones", () => {
  const merged = mergeEnv("FOO=1\nSTELLAR_NETWORK=old\nOPENAI_API_KEY=keep\n", {
    STELLAR_NETWORK: "testnet",
    NEW_KEY: "x",
  });
  assert.match(merged, /^FOO=1$/m);
  assert.match(merged, /^OPENAI_API_KEY=keep$/m);
  assert.match(merged, /^STELLAR_NETWORK=testnet$/m);
  assert.match(merged, /^NEW_KEY=x$/m);
  assert.ok(!merged.includes("old"));
  assert.equal(mergeEnv(merged, { NEW_KEY: "x" }), merged); // idempotent
});

test("envValues never includes the secret unless asked", () => {
  const base = { publicKey: "G" + "A".repeat(55), contracts: { registry: REGISTRY, nameService: NAME_SERVICE } };
  assert.ok(!("STELLAR_OPERATOR_SECRET_KEY" in envValues(base)));
  assert.equal(envValues({ ...base, secret: "S123" }).STELLAR_OPERATOR_SECRET_KEY, "S123");
});

test("secrets may not be stored inside the repository", () => {
  assert.throws(() => assertOutsideRepo("/repo/.talos", "/repo"), /inside the repository/);
  assert.throws(() => assertOutsideRepo("/repo", "/repo"), /inside the repository/);
  assert.doesNotThrow(() => assertOutsideRepo("/home/u/.config/talos", "/repo"));
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--plan", "--force", "--skip-db", "--write-operator-secret"]), {
    plan: true,
    force: true,
    skipDb: true,
    writeOperatorSecret: true,
  });
  assert.throws(() => parseArgs(["--mainnet"]), /unknown option/);
});

// ── end-to-end with a fake chain and fake child processes ───────────────────

function harness() {
  const repoRoot = mkdtempSync(join(tmpdir(), "tb-repo-"));
  mkdirSync(join(repoRoot, "web"), { recursive: true });
  const dir = join(mkdtempSync(join(tmpdir(), "tb-home-")), "talos");
  const chain = { accounts: new Map() };
  const out = [];
  const execLog = [];
  const stdinSeen = [];

  const deps = {
    repoRoot,
    log: (m) => out.push(m),
    fetch: async (url) => {
      const u = new URL(url);
      if (u.hostname === "friendbot.stellar.org") {
        chain.accounts.set(u.searchParams.get("addr"), { balances: [{ asset_type: "native" }] });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      const addr = u.pathname.split("/")[2];
      const acct = chain.accounts.get(addr);
      return acct
        ? { ok: true, status: 200, json: async () => acct }
        : { ok: false, status: 404, json: async () => ({}) };
    },
    exec: (cmd, args, { env = {}, input } = {}) => {
      execLog.push({ cmd, args, env });
      if (input) stdinSeen.push(input);
      const joined = args.join(" ");
      if (cmd === "stellar" && args[0] === "--version") return { status: 0, output: "stellar 23.0.0" };
      if (cmd === "stellar") return { status: 0, output: "" };
      if (cmd === "bash") {
        return {
          status: 0,
          output: `NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=${REGISTRY}\nNEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=${NAME_SERVICE}\n`,
        };
      }
      if (joined.includes("add-usdc-trustline")) {
        const acct = chain.accounts.get(
          [...chain.accounts.keys()].at(-1),
        );
        acct.balances.push({ asset_code: "USDC", asset_issuer: USDC_ISSUER });
        return { status: 0, output: `Account: whatever\nTrustline created` };
      }
      if (joined.includes("mint-mitos")) {
        // The real script prints issuer secrets; the bootstrap must keep them off stdout.
        return { status: 0, output: `Issuer secret: ${ISSUER_SECRET}\nminted` };
      }
      return { status: 0, output: "ok" };
    },
  };
  return { deps, dir, repoRoot, out, execLog, stdinSeen, chain };
}

const e2eEnv = { DATABASE_URL: "postgresql://postgres:dbpassword123@127.0.0.1:5432/talos" };

test("fresh run builds the environment end to end", async () => {
  const h = harness();
  const res = await run({ dir: h.dir }, h.deps, e2eEnv);
  assert.deepEqual(res.ran, ["keys", "fund", "trustline", "contracts", "env", "db-migrate", "seed-agents", "mint"]);

  const state = JSON.parse(readFileSync(join(h.dir, "state.json"), "utf8"));
  assert.deepEqual(state.contracts, { registry: REGISTRY, nameService: NAME_SERVICE });

  const env = readFileSync(join(h.repoRoot, "web", ".env.local"), "utf8");
  assert.match(env, new RegExp(`NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=${REGISTRY}`));
  assert.match(env, new RegExp(`STELLAR_OPERATOR_PUBLIC_KEY=${state.publicKey}`));
  assert.ok(!/STELLAR_OPERATOR_SECRET_KEY/.test(env), "secret must not be in the env file by default");
  assert.ok(!env.includes("dbpassword123"), "user-supplied DATABASE_URL must not be copied");

  // Secrets file: outside the repo, private, holds operator + issuer secrets.
  const secrets = readFileSync(join(h.dir, "secrets.env"), "utf8");
  assert.match(secrets, /^STELLAR_OPERATOR_SECRET_KEY=S[A-Z2-7]{55}$/m);
  assert.ok(secrets.includes(ISSUER_SECRET));
  if (process.platform !== "win32") {
    assert.equal(statSync(join(h.dir, "secrets.env")).mode & 0o777, 0o600);
    assert.equal(statSync(join(h.dir, "state.json")).mode & 0o777, 0o600);
  }
});

test("nothing secret reaches stdout", async () => {
  const h = harness();
  await run({ dir: h.dir }, h.deps, e2eEnv);
  const all = h.out.join("\n");
  const operatorSecret = /STELLAR_OPERATOR_SECRET_KEY=(\S+)/.exec(readFileSync(join(h.dir, "secrets.env"), "utf8"))[1];
  assert.ok(!all.includes(operatorSecret));
  assert.ok(!all.includes(ISSUER_SECRET));
  assert.ok(!all.includes("dbpassword123"));
  assert.ok(!/\bS[A-Z2-7]{55}\b/.test(all));
});

test("the operator secret is passed to children by env or stdin, never argv", async () => {
  const h = harness();
  await run({ dir: h.dir }, h.deps, e2eEnv);
  const secrets = readFileSync(join(h.dir, "secrets.env"), "utf8");
  const operatorSecret = /STELLAR_OPERATOR_SECRET_KEY=(\S+)/.exec(secrets)[1];
  for (const c of h.execLog) {
    assert.ok(!c.args.join(" ").includes(operatorSecret), `${c.cmd} leaked the secret in argv`);
  }
  assert.equal(h.stdinSeen[0].trim(), operatorSecret);
  assert.ok(h.execLog.some((c) => c.env.STELLAR_OPERATOR_SECRET_KEY === operatorSecret));
});

test("re-running skips everything and does no work", async () => {
  const h = harness();
  await run({ dir: h.dir }, h.deps, e2eEnv);
  const before = h.execLog.length;
  const res = await run({ dir: h.dir }, h.deps, e2eEnv);
  assert.deepEqual(res.ran, []);
  assert.equal(h.execLog.length, before);
});

test("an interrupted run resumes at the failed step", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  let failMigrate = true;
  h.deps.exec = (cmd, args, o) =>
    failMigrate && args.join(" ").includes("db:migrate") ? { status: 1, output: "ECONNREFUSED" } : realExec(cmd, args, o);

  await assert.rejects(run({ dir: h.dir }, h.deps, e2eEnv), /step "db-migrate" failed.*127\.0\.0\.1/s);

  failMigrate = false;
  const res = await run({ dir: h.dir }, h.deps, e2eEnv);
  assert.deepEqual(res.ran, ["db-migrate", "seed-agents", "mint"]);
});

test("failure messages do not leak the database password", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (cmd, args, o) =>
    args.join(" ").includes("db:migrate") ? { status: 1, output: "boom" } : realExec(cmd, args, o);
  await assert.rejects(run({ dir: h.dir }, h.deps, e2eEnv), (e) => !e.message.includes("dbpassword123"));
});

test("fails closed when the trustline helper swallows an error", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  // The real helper catches its own errors and exits 0 without creating the trustline.
  h.deps.exec = (cmd, args, o) =>
    args.join(" ").includes("add-usdc-trustline") ? { status: 0, output: "Error: tx_failed" } : realExec(cmd, args, o);
  await assert.rejects(run({ dir: h.dir }, h.deps, e2eEnv), /step "trustline" failed/);
});

test("fails with a clear message when the Stellar CLI is missing", async () => {
  const h = harness();
  const realExec = h.deps.exec;
  h.deps.exec = (cmd, args, o) =>
    cmd === "stellar" ? { status: 127, output: "not found" } : realExec(cmd, args, o);
  await assert.rejects(run({ dir: h.dir }, h.deps, e2eEnv), /Stellar CLI/);
});

test("--plan changes nothing", async () => {
  const h = harness();
  const res = await run({ dir: h.dir, plan: true }, h.deps, e2eEnv);
  assert.equal(res.ran.length, 0);
  assert.equal(h.execLog.length, 0);
  assert.ok(!existsSync(join(h.dir, "state.json")));
});

test("refuses to keep secrets inside the repo", async () => {
  const h = harness();
  await assert.rejects(run({ dir: join(h.repoRoot, ".bootstrap") }, h.deps, e2eEnv), /inside the repository/);
});

test("--write-operator-secret opts the secret into the git-ignored env file", async () => {
  const h = harness();
  await run({ dir: h.dir, writeOperatorSecret: true }, h.deps, e2eEnv);
  const env = readFileSync(join(h.repoRoot, "web", ".env.local"), "utf8");
  assert.match(env, /^STELLAR_OPERATOR_SECRET_KEY=S[A-Z2-7]{55}$/m);
});

test("existing .env.local values survive the merge", async () => {
  const h = harness();
  writeFileSync(join(h.repoRoot, "web", ".env.local"), "OPENAI_API_KEY=keepme\n");
  await run({ dir: h.dir }, h.deps, e2eEnv);
  assert.match(readFileSync(join(h.repoRoot, "web", ".env.local"), "utf8"), /^OPENAI_API_KEY=keepme$/m);
});
