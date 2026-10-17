/**
 * smoke-fixture.lib.mjs
 *
 * Pure, dependency-free building blocks for the deterministic full-stack
 * smoke fixture (`web/tests/fixtures/smoke-fixture.json`).
 *
 * Design rules (mirrors scripts/generate-registry-fixtures.mjs):
 * - Deterministic: no Date.now(), no Math.random(), no network, no env reads.
 * - Canonical output: sorted JSON keys, 2-space indent, trailing newline.
 * - Fail closed: ambiguous, malformed, or sensitive input produces an
 *   explicit error and a non-zero exit path — never a best-effort guess.
 * - Privacy-safe: errors name fields and paths only; values are never
 *   echoed, and field names that look like secrets are rejected outright.
 *
 * Both the generator script and the vitest suite import this module, so
 * there is exactly one source of truth for fixture semantics.
 */

export const SMOKE_FIXTURE_SCHEMA_VERSION = 1;

/** Repo-relative path of the committed fixture. */
export const FIXTURE_REL_PATH = "web/tests/fixtures/smoke-fixture.json";

// ─── Deterministic primitives ────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash over UTF-16 code units. Pure and stable across
 * platforms and processes — used to derive fixture identifiers instead of
 * randomness so every regeneration is byte-identical.
 */
export function fnv1a32(input) {
  if (typeof input !== "string") {
    throw new TypeError("fnv1a32 expects a string");
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic fixture agent id derived from the agent name. */
export function deriveDeterministicId(name) {
  return `smoke-${fnv1a32(name).toString(16).padStart(8, "0")}`;
}

/**
 * Deterministic truncated placeholder address in the same style as
 * `web/src/db/seed.ts` (e.g. "0x7a3F...e4B2"). Placeholder only — the smoke
 * fixture never contains real keys, seeds, or payment material.
 */
export function deriveTruncatedAddress(name) {
  const h = fnv1a32(`${name}:address`).toString(16).padStart(8, "0");
  return `0x${h.slice(0, 4)}...${h.slice(4, 8)}`;
}

// ─── Fixture definition ──────────────────────────────────────────────────────

const SMOKE_AGENTS = [
  {
    name: "smoke-signal",
    category: "Sales",
    description: "Smoke fixture agent exposing a deterministic intent-signal service.",
    onChainId: 901,
    serviceName: "smoke_intent_signal",
    servicePrice: "0.01",
    serviceDesc: "Deterministic smoke intent-signal result for local stack verification.",
  },
  {
    name: "smoke-scout",
    category: "Analytics",
    description: "Smoke fixture agent exposing a deterministic trend-research service.",
    onChainId: 902,
    serviceName: "smoke_trend_research",
    servicePrice: "0.005",
    serviceDesc: "Deterministic smoke trend-research result for local stack verification.",
  },
  {
    name: "smoke-nexus",
    category: "Development",
    description: "Smoke fixture agent exposing a deterministic payment-integration service.",
    onChainId: 903,
    serviceName: "smoke_payment_integration",
    servicePrice: "0.01",
    serviceDesc: "Deterministic smoke payment-integration result for local stack verification.",
  },
  {
    name: "smoke-voice",
    category: "Marketing",
    description: "Smoke fixture agent exposing a deterministic product-review service.",
    onChainId: 904,
    serviceName: "smoke_product_review",
    servicePrice: "0.012",
    serviceDesc: "Deterministic smoke product-review result for local stack verification.",
  },
];

/**
 * Build the full smoke fixture. Pure: same inputs (none) → identical output,
 * always. Field names mirror `web/src/db/seed.ts` and the marketplace
 * `GET /api/services` contract so the fixture can drive the local stack
 * (`pnpm stack:up`) without a parallel source of truth.
 */
export function buildSmokeFixture() {
  return {
    meta: {
      name: "talos-smoke-fixture",
      schemaVersion: SMOKE_FIXTURE_SCHEMA_VERSION,
      deterministic: true,
      generatedBy: "scripts/generate-smoke-fixture.mjs",
      description:
        "Deterministic full-stack smoke fixture: local stack ports, health expectations, and mock marketplace agents. Regenerate with `pnpm smoke:fixture:gen`; verify with `pnpm smoke:fixture:check`. Contains placeholder data only — never secrets, seeds, keys, or payment proofs.",
    },
    stack: {
      webPort: 3000,
      mockStellarPort: 4010,
      marketplacePath: "/api/services",
      health: {
        path: "/api/health",
        livePath: "/api/health/live",
        readyPath: "/api/health/ready",
        expectedReadyHealthyStatus: 200,
        expectedReadyDegradedStatus: 503,
      },
    },
    marketplace: {
      defaultLimit: 50,
      maxLimit: 100,
    },
    agents: SMOKE_AGENTS.map((agent) => ({
      id: deriveDeterministicId(agent.name),
      name: agent.name,
      category: agent.category,
      description: agent.description,
      status: "Active",
      onChainId: agent.onChainId,
      creatorAddress: deriveTruncatedAddress(agent.name),
      serviceName: agent.serviceName,
      serviceDescription: agent.serviceDesc,
      price: agent.servicePrice,
      currency: "USDC",
      chains: ["stellar"],
      fulfillmentMode: "instant",
    })),
  };
}

// ─── Canonical JSON ──────────────────────────────────────────────────────────

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Canonical form: sorted keys, 2-space indent, trailing newline. */
export function canonicalize(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

// ─── Drift detection (used by --check and CI) ────────────────────────────────

/**
 * Compare committed fixture content against the expected canonical output.
 * Returns null when identical, otherwise a short, privacy-safe reason.
 * Never includes file contents in the result.
 */
export function findDrift(expectedCanonical, actualContent) {
  if (typeof actualContent !== "string") {
    return "fixture content is unreadable";
  }
  if (actualContent === expectedCanonical) return null;

  try {
    const reparsed = canonicalize(JSON.parse(actualContent));
    if (reparsed === expectedCanonical) {
      return "not canonically formatted (sorted keys, 2-space indent, trailing newline)";
    }
  } catch {
    return "not valid JSON";
  }
  return "content differs from the canonical fixture";
}

// ─── Fail-closed validation ──────────────────────────────────────────────────

const MAX_AGENTS = 64;
const MAX_CHAINS = 1;
const ON_CHAIN_ID_MAX = 0xffffffff; // 2^32 - 1
const PORT_MAX = 65535;
const MARKETPLACE_LIMIT_MAX = 100;
const PRICE_PATTERN = /^\d+\.\d{1,6}$/; // decimal notation required; 1–6 decimals
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{4}\.\.\.[0-9a-fA-F]{4}$/;
const ID_PATTERN = /^smoke-[0-9a-f]{8}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9_]{3,64}$/;
const PATH_PATTERN = /^\/[A-Za-z0-9\-._/]*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Field names that must never appear in a smoke fixture (fail closed). */
const SENSITIVE_FIELD_PATTERN = /(secret|seed|private|password|passphrase|mnemonic|token|api[_-]?key|credential|proof)/i;

const TOP_LEVEL_KEYS = ["agents", "marketplace", "meta", "stack"].sort();
const META_KEYS = ["description", "deterministic", "generatedBy", "name", "schemaVersion"].sort();
const AGENT_KEYS = [
  "category",
  "chains",
  "creatorAddress",
  "currency",
  "description",
  "fulfillmentMode",
  "id",
  "name",
  "onChainId",
  "price",
  "serviceDescription",
  "serviceName",
  "status",
].sort();
const MARKETPLACE_KEYS = ["defaultLimit", "maxLimit"].sort();
const STACK_KEYS = ["health", "marketplacePath", "mockStellarPort", "webPort"].sort();
const STACK_HEALTH_KEYS = [
  "expectedReadyDegradedStatus",
  "expectedReadyHealthyStatus",
  "livePath",
  "path",
  "readyPath",
].sort();

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectKeys(errors, path, value, expected) {
  const actual = Object.keys(value).sort();
  const unknown = actual.filter((k) => !expected.includes(k));
  for (const k of unknown) errors.push(`${path}: unknown field "${k}" is not allowed`);
  const missing = expected.filter((k) => !actual.includes(k));
  for (const k of missing) errors.push(`${path}: missing required field "${k}"`);
}

function expectNonEmptyString(errors, path, value) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: must be a non-empty string`);
    return false;
  }
  return true;
}

function expectPattern(errors, path, value, pattern, hint) {
  if (!expectNonEmptyString(errors, path, value)) return false;
  if (!pattern.test(value)) {
    errors.push(`${path}: ${hint}`);
    return false;
  }
  return true;
}

function expectIntInRange(errors, path, value, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    errors.push(`${path}: must be an integer`);
    return false;
  }
  if (value < min || value > max) {
    errors.push(`${path}: must be between ${min} and ${max} inclusive`);
    return false;
  }
  return true;
}

function validateAgent(errors, path, agent) {
  if (!isPlainObject(agent)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  expectKeys(errors, path, agent, AGENT_KEYS);

  // Privacy gate: reject secret-shaped field names before anything else and
  // without echoing any value.
  for (const key of Object.keys(agent)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      errors.push(`${path}.${key}: sensitive field names are not allowed in the smoke fixture`);
    }
  }

  expectPattern(errors, `${path}.id`, agent.id, ID_PATTERN, 'must match "smoke-" plus 8 lowercase hex chars');
  expectPattern(errors, `${path}.name`, agent.name, NAME_PATTERN, "must be a lowercase slug of 2-63 chars (a-z, 0-9, hyphen)");
  expectNonEmptyString(errors, `${path}.category`, agent.category);
  expectNonEmptyString(errors, `${path}.description`, agent.description);

  if (agent.status !== "Active") {
    errors.push(`${path}.status: must be "Active" (smoke agents are always active)`);
  }
  expectIntInRange(errors, `${path}.onChainId`, agent.onChainId, 1, ON_CHAIN_ID_MAX);
  expectPattern(errors, `${path}.creatorAddress`, agent.creatorAddress, ADDRESS_PATTERN, "must be a truncated placeholder address like 0xabcd...ef01");
  expectPattern(errors, `${path}.serviceName`, agent.serviceName, SERVICE_NAME_PATTERN, "must be a lowercase snake_case identifier of 3-64 chars");
  expectNonEmptyString(errors, `${path}.serviceDescription`, agent.serviceDescription);

  // Price: decimal notation with 1-6 decimals, strictly positive. Values like
  // "1" or "0" are rejected as ambiguous money formatting (fail closed).
  if (expectPattern(errors, `${path}.price`, agent.price, PRICE_PATTERN, 'must be a decimal string with 1-6 decimals, e.g. "0.01"')) {
    if (Number(agent.price) <= 0) {
      errors.push(`${path}.price: must be greater than zero`);
    }
  }

  if (agent.currency !== "USDC") {
    errors.push(`${path}.currency: must be "USDC"`);
  }

  if (!Array.isArray(agent.chains)) {
    errors.push(`${path}.chains: must be an array`);
  } else if (agent.chains.length < 1 || agent.chains.length > MAX_CHAINS) {
    errors.push(`${path}.chains: must contain exactly ${MAX_CHAINS} entry`);
  } else if (agent.chains.some((c) => c !== "stellar")) {
    errors.push(`${path}.chains: only "stellar" is supported by the local smoke stack`);
  }

  if (agent.fulfillmentMode !== "instant") {
    errors.push(`${path}.fulfillmentMode: must be "instant"`);
  }
}

/**
 * Validate a parsed smoke fixture object. Fail closed: any unknown field,
 * missing field, malformed value, boundary violation, duplicate identity, or
 * secret-shaped field name produces an explicit, privacy-safe error.
 *
 * Returns { ok: true, errors: [] } or { ok: false, errors: string[] }.
 */
export function validateSmokeFixture(fixture) {
  const errors = [];

  if (!isPlainObject(fixture)) {
    return { ok: false, errors: ["fixture: must be a JSON object"] };
  }

  expectKeys(errors, "fixture", fixture, TOP_LEVEL_KEYS);

  // Privacy gate over the whole tree: report the offending path, never values.
  const scan = (node, path) => {
    if (!isPlainObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        errors.push(`${childPath}: sensitive field names are not allowed in the smoke fixture`);
      }
      scan(child, childPath);
    }
  };
  scan(fixture, "fixture");

  // ── meta ──
  if (isPlainObject(fixture.meta)) {
    expectKeys(errors, "fixture.meta", fixture.meta, META_KEYS);
    expectPattern(errors, "fixture.meta.name", fixture.meta.name, SLUG_PATTERN, "must be a lowercase slug (a-z, 0-9, hyphen)");
    expectNonEmptyString(errors, "fixture.meta.description", fixture.meta.description);
    expectNonEmptyString(errors, "fixture.meta.generatedBy", fixture.meta.generatedBy);
    if (fixture.meta.deterministic !== true) {
      errors.push("fixture.meta.deterministic: must be true (a non-deterministic smoke fixture is ambiguous and rejected)");
    }
    if (fixture.meta.schemaVersion !== SMOKE_FIXTURE_SCHEMA_VERSION) {
      errors.push(`fixture.meta.schemaVersion: must be ${SMOKE_FIXTURE_SCHEMA_VERSION}`);
    }
  }

  // ── stack ──
  if (isPlainObject(fixture.stack)) {
    expectKeys(errors, "fixture.stack", fixture.stack, STACK_KEYS);
    expectIntInRange(errors, "fixture.stack.webPort", fixture.stack.webPort, 1, PORT_MAX);
    expectIntInRange(errors, "fixture.stack.mockStellarPort", fixture.stack.mockStellarPort, 1, PORT_MAX);
    expectPattern(errors, "fixture.stack.marketplacePath", fixture.stack.marketplacePath, PATH_PATTERN, "must be an absolute path like /api/services");

    const health = fixture.stack.health;
    if (isPlainObject(health)) {
      expectKeys(errors, "fixture.stack.health", health, STACK_HEALTH_KEYS);
      expectPattern(errors, "fixture.stack.health.path", health.path, PATH_PATTERN, "must be an absolute path like /api/health");
      expectPattern(errors, "fixture.stack.health.livePath", health.livePath, PATH_PATTERN, "must be an absolute path");
      expectPattern(errors, "fixture.stack.health.readyPath", health.readyPath, PATH_PATTERN, "must be an absolute path");
      if (health.expectedReadyHealthyStatus !== 200) {
        errors.push("fixture.stack.health.expectedReadyHealthyStatus: must be 200");
      }
      if (health.expectedReadyDegradedStatus !== 503) {
        errors.push("fixture.stack.health.expectedReadyDegradedStatus: must be 503");
      }
    }
  }

  // ── marketplace ──
  if (isPlainObject(fixture.marketplace)) {
    expectKeys(errors, "fixture.marketplace", fixture.marketplace, MARKETPLACE_KEYS);
    const { defaultLimit, maxLimit } = fixture.marketplace;
    expectIntInRange(errors, "fixture.marketplace.defaultLimit", defaultLimit, 1, MARKETPLACE_LIMIT_MAX);
    expectIntInRange(errors, "fixture.marketplace.maxLimit", maxLimit, 1, MARKETPLACE_LIMIT_MAX);
    if (
      typeof defaultLimit === "number" &&
      typeof maxLimit === "number" &&
      Number.isInteger(defaultLimit) &&
      Number.isInteger(maxLimit) &&
      defaultLimit > maxLimit
    ) {
      errors.push("fixture.marketplace.defaultLimit: must be less than or equal to maxLimit");
    }
  }

  // ── agents ──
  if (!Array.isArray(fixture.agents)) {
    errors.push("fixture.agents: must be an array");
  } else if (fixture.agents.length < 1) {
    errors.push("fixture.agents: must contain at least one agent");
  } else if (fixture.agents.length > MAX_AGENTS) {
    errors.push(`fixture.agents: must contain at most ${MAX_AGENTS} agents`);
  } else {
    const seenIds = new Set();
    const seenNames = new Set();
    const seenOnChainIds = new Set();
    const seenServiceNames = new Set();

    fixture.agents.forEach((agent, index) => {
      const path = `fixture.agents[${index}]`;
      validateAgent(errors, path, agent);

      if (isPlainObject(agent)) {
        if (typeof agent.id === "string" && seenIds.has(agent.id)) {
          errors.push(`${path}.id: duplicate agent id (ids must be unique)`);
        }
        if (typeof agent.name === "string" && seenNames.has(agent.name)) {
          errors.push(`${path}.name: duplicate agent name (names must be unique)`);
        }
        if (Number.isInteger(agent.onChainId) && seenOnChainIds.has(agent.onChainId)) {
          errors.push(`${path}.onChainId: duplicate on-chain id (ids must be unique)`);
        }
        if (typeof agent.serviceName === "string" && seenServiceNames.has(agent.serviceName)) {
          errors.push(`${path}.serviceName: duplicate service name (names must be unique)`);
        }
        seenIds.add(agent.id);
        seenNames.add(agent.name);
        seenOnChainIds.add(agent.onChainId);
        seenServiceNames.add(agent.serviceName);
      }
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}
