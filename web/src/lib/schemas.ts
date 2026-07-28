/**
 * Zod schemas for API request validation.
 * Shared across all POST endpoints to ensure consistent validation.
 */
import { z } from "zod/v4";
import { StrKey } from "@stellar/stellar-sdk";

export const stellarAssetCodeSchema = z
  .string()
  .min(1, "Asset code must be at least 1 character")
  .max(12, "Asset code must be at most 12 characters")
  .regex(
    /^[A-Z0-9]+$/,
    "Asset code must contain only uppercase letters and numbers",
  );

export const stellarPublicKeySchema = z
  .string()
  .startsWith("G", "Stellar public key must start with 'G'")
  .length(56, "Stellar public key must be exactly 56 characters")
  .refine(
    (key) => {
      try {
        return StrKey.isValidEd25519PublicKey(key);
      } catch {
        return false;
      }
    },
    { message: "Invalid Stellar Ed25519 public key" },
  );

export const stellarNativeAssetSchema = z.object({
  type: z.literal("native"),
}).strict();

export const stellarIssuedAssetSchema = z.object({
  type: z.literal("issued"),
  code: stellarAssetCodeSchema,
  issuer: stellarPublicKeySchema,
}).strict();

export const stellarAssetSchema = z.discriminatedUnion("type", [
  stellarNativeAssetSchema,
  stellarIssuedAssetSchema,
]);

// ── Stellar StrKey helpers ───────────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array | null {
  const cleaned = input.toUpperCase().replace(/=/g, "");
  const len = cleaned.length;
  if (len === 0 || len % 8 !== 0) return null;

  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < len; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    table[i] = c & 0xffff;
  }
  return table;
})();

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC16_TABLE[((crc >>> 8) ^ b) & 0xff]) & 0xffff;
  return crc;
}

/**
 * Decode a Stellar StrKey-encoded public key and verify its CRC16 checksum.
 * Accepts version bytes 0x30 (ed25519 public) and 0xb0 (ed25519签 seed).
 * Returns the raw payload on success, null on any validation failure.
 */
function decodeStrKey(strKey: string): Uint8Array | null {
  if (typeof strKey !== "string") return null;
  const decoded = base32Decode(strKey);
  if (!decoded || decoded.length < 4) return null;

  const version = decoded[0];
  if (version !== 0x30 && version !== 0xb0) return null;

  const payload = decoded.slice(0, decoded.length - 2);
  // Stellar stores CRC-16 little-endian (LSB first)
  const checksum =
    decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);

  if (crc16(payload) !== checksum) return null;

  // ed25519 public key payload must be exactly 32 bytes (version + 32)
  if (version === 0x30 && payload.length !== 33) return null;
  // ed25519 secret seed payload must be exactly 33 bytes (version + 32)
  if (version === 0xb0 && payload.length !== 33) return null;

  return payload;
}

function isValidStellarPublicKey(value: string): boolean {
  return decodeStrKey(value) !== null;
}

// ── Shared Stellar asset schema ──────────────────────────────────────────────

/**
 * Discriminated schema for Stellar native or issued assets.
 *
 * Native (XLM):
 *   { "native": true }
 *
 * Issued token (e.g. USDC, MITOS):
 *   { "code": "USDC", "issuer": "GABC...56chars" }
 *
 * The issuer field must be a valid Stellar StrKey with a verified CRC16
 * checksum.  Asset codes are constrained to 1-12 uppercase alphanumeric
 * characters, matching the Stellar protocol limits.
 */
export const stellarAssetSchema = z.union([
  z.object({
    native: z.literal(true),
    code: z.undefined().optional(),
    issuer: z.undefined().optional(),
  }),
  z.object({
    native: z.undefined().optional(),
    code: z
      .string()
      .min(1, "Asset code is required for issued assets")
      .max(12, "Asset code must be at most 12 characters")
      .regex(/^[A-Z0-9]{1,12}$/, "Asset code must be 1-12 uppercase alphanumeric characters"),
    issuer: z.string().refine(isValidStellarPublicKey, {
      message: "Issuer must be a valid Stellar public key (G..., 56 chars, valid checksum)",
    }),
  }),
]);

/** Inferred type for use in route handlers. */
export type StellarAsset = z.infer<typeof stellarAssetSchema>;

/**
 * Optional asset field for schemas where the caller may omit the asset
 * (defaults to native XLM).  When provided, the value must pass the full
 * stellarAssetSchema validation.
 */
export const optionalStellarAssetField = stellarAssetSchema.optional();

// ── Categories ───────────────────────────────────────────────────────────────

export const VALID_CATEGORIES = [
  "Marketing", "Development", "Research", "Design", "Finance",
  "Analytics", "Operations", "Sales", "Support", "Education",
] as const;

const VALID_ACTIVITY_TYPES = [
  "post", "research", "reply", "engagement", "commerce", "approval",
] as const;

const VALID_APPROVAL_TYPES = [
  "transaction", "strategy", "policy", "channel",
] as const;

// --- TALOS ---

export const createTalosSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.enum(VALID_CATEGORIES),
  description: z.string().min(1).max(2000),
  totalSupply: z.number().int().positive().max(100_000_000).optional().default(1_000_000),
  persona: z.string().max(2000).optional(),
  targetAudience: z.string().max(2000).optional(),
  channels: z.array(z.string()).optional().default([]),
  toneVoice: z.string().max(500).nullable().optional(),
  approvalThreshold: z.number().nonnegative().optional().default(10),
  gtmBudget: z.number().nonnegative().optional().default(200),
  creatorPublicKey: stellarPublicKeySchema,
  signature: z.string().min(1),
  message: z.string().min(1),
  walletPublicKey: z.string().min(1).optional(),
  onChainId: z.number().int().nullable().optional(),
  agentName: z.string().max(100).nullable().optional(),
  initialPrice: z.number().nonnegative().optional().default(0),
  minPatronPulse: z.number().int().nonnegative().nullable().optional(),
  stellarAssetCode: z.string().nullable().optional().refine(
    (val) => {
      if (val === null || val === undefined || val === "") return true;
      const match = val.match(/^([A-Z0-9]{1,12}):(.+)$/);
      if (!match) return false;
      return isValidStellarPublicKey(match[2]);
    },
    { message: "stellarAssetCode must be null or in the format 'CODE:G...55chars' with a valid issuer checksum (e.g. 'MITOS:GABC...')" },
  ),
  tokenSymbol: z.string().max(20).nullable().optional(),
  serviceName: z.string().min(1).max(200).optional(),
  serviceDescription: z.string().max(2000).optional(),
  servicePrice: z.number().positive().max(1_000_000).optional(),
});

// --- Activity ---

export const reportActivitySchema = z.object({
  type: z.enum(VALID_ACTIVITY_TYPES),
  content: z.string().min(1).max(5000),
  channel: z.string().max(100).optional(),
  status: z.string().max(50).optional().default("completed"),
});

// --- Approvals ---

export const createApprovalSchema = z.object({
  type: z.enum(VALID_APPROVAL_TYPES),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amount: z.number().nonnegative().optional(),
});

export const decideApprovalSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  decidedBy: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
  txHash: z.string().optional(),
});

// --- Transfer (Stellar USDC) ---

export const transferSchema = z.object({
  to: z.string().min(1),     // Stellar public key (G...)
  amount: z.number().positive(),
  currency: z.string().optional().default("USDC"),
});

// --- Patrons ---

export const becomePatronSchema = z.object({
  stellarPublicKey: z.string().min(1),
  pulseAmount: z.number().positive(),
  signature: z.string().min(1),
  message: z.string().min(1),
});

export const revokePatronSchema = z.object({
  stellarPublicKey: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

// --- Commerce Service ---

export const registerServiceSchema = z.object({
  serviceName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  price: z.number().positive(),
  stellarPublicKey: z.string().optional(),
  chains: z.array(z.string()).optional().default(["stellar"]),
  fulfillmentMode: z.enum(["instant", "async"]).optional().default("async"),
});

// --- Cross-Chain Commerce Webhook ---

export const crossChainWebhookSchema = z.object({
  jobId: z.string().min(1).optional(),
  talosId: z.string().min(1),
  requesterTalosId: z.string().min(1),
  sourceChain: z.string().min(1),
  destinationChain: z.string().optional().default("stellar"),
  paymentReference: z.string().min(1),
  sourceTxHash: z.string().min(1),
  amount: z.coerce.number().positive(),
  currency: z.string().optional().default("USDC"),
  simulatedVerified: z.boolean().optional().default(false),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});
// --- Commerce Job Bidding ---

// Full set of statuses used internally / by the server
export const VALID_BID_STATUSES = [
  "pending", "negotiating", "accepted", "counter_offer", "rejected", "completed",
] as const;

// Only these statuses may be submitted by a client in a bid payload.
// Terminal states (accepted, rejected, completed) and initial states (pending)
// are set exclusively by the server after verification/settlement.
export const CLIENT_BID_STATUSES = ["negotiating", "counter_offer"] as const;

export const submitBidSchema = z.object({
  bidPrice: z.number().positive().optional(),
  status: z.enum(CLIENT_BID_STATUSES).optional(),
});

// --- Revenue ---

export const reportRevenueSchema = z.object({
  amount: z.string().min(1),
  currency: z.string().optional().default("USDC"),
  source: z.string().min(1).max(200),
  txHash: z.string().nullable().optional(),
});

// --- Dividends (Patron distribution history) ---

const dividendBreakdownEntrySchema = z.object({
  stellarPublicKey: z.string().min(1),
  pulseAmount: z.number().int().nonnegative().optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  txHash: z.string().nullable().optional(),
});

export const recordDividendSchema = z.object({
  // Total distributed amount. Accept string (numeric column) or number.
  amount: z.union([z.string().min(1), z.number().positive()]),
  currency: z.string().max(20).optional().default("USDC"),
  patronCount: z.number().int().nonnegative().optional().default(0),
  totalPulse: z.number().int().nonnegative().optional().default(0),
  source: z.string().max(50).optional().default("revenue-share"),
  txHash: z.string().nullable().optional(),
  breakdown: z.array(dividendBreakdownEntrySchema).optional(),
  status: z.enum(["completed", "pending", "failed"]).optional().default("completed"),
});

// --- Status ---

export const updateStatusSchema = z.object({
  agentOnline: z.boolean(),
});

// --- Regenerate Key ---

export const regenerateKeySchema = z.object({
  stellarPublicKey: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

// --- Retire Agent ---

export const retireAgentSchema = z.object({
  reason: z.string().min(1).max(1000),
  supersededBy: z.string().nullable().optional(),
  stellarPublicKey: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

// --- Delete Agent (Privacy Deletion) ---

export const deleteAgentSchema = z.object({
  reason: z.string().min(1).max(1000),
  stellarPublicKey: z.string().min(1),
  signature: z.string().min(1),
  message: z.string().min(1),
});

// --- Sign Payment (Stellar x402) ---

export const signPaymentSchema = z.object({
  payee: z.string().min(1),
  amount: z.union([z.string(), z.number()]),
  assetCode: stellarAssetCodeSchema.optional().default("USDC"),
});

// --- Buy Token ---

export const buyTokenSchema = z.object({
  buyerPublicKey: z.string().min(1),     // Stellar public key
  amount: z.number().positive(),
});

// --- Playbooks ---

export const createPlaybookSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  channel: z.string().max(100).optional(),
  description: z.string().max(5000).optional(),
  price: z.string().min(1),
  currency: z.string().optional().default("USDC"),
  content: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional().default([]),
  impressions: z.number().int().nonnegative().optional().default(0),
  engagementRate: z.string().optional().default("0"),
  conversions: z.number().int().nonnegative().optional().default(0),
  periodDays: z.number().int().positive().optional().default(30),
});

// --- API Key Management ---

const VALID_SCOPE_VALUES = [
  "admin", "activity:write", "commerce:read", "commerce:write",
  "wallet:read", "wallet:sign", "settings:read", "settings:write",
  "revenue:read", "revenue:write",
] as const;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPE_VALUES)).min(1),
  expiresAt: z.string().datetime().optional(),
});

export const updateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopes: z.array(z.enum(VALID_SCOPE_VALUES)).min(1).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

/**
 * Parse and validate request body with a Zod schema.
 * Returns { data, error } — if error is set, return it as the Response.
 *
 * Error responses use the standardised envelope from @/lib/api-response
 * so callers never need to import that module separately.
 */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<{ data: z.infer<T>; error?: undefined } | { data?: undefined; error: Response }> {
  const { invalidJson, validationError } = await import("@/lib/api-response");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: invalidJson(request) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { error: validationError(request, issues) };
  }

  return { data: result.data };
}
