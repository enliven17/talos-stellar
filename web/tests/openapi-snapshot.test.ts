import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/docs/openapi.json/route";
import { z } from "zod/v4";
import {
  becomePatronSchema,
  buyTokenSchema,
  claimJobSchema,
  createApprovalSchema,
  createPlaybookSchema,
  createTalosSchema,
  crossChainWebhookSchema,
  decideApprovalSchema,
  heartbeatJobSchema,
  recordDividendSchema,
  regenerateKeySchema,
  registerServiceSchema,
  releaseJobSchema,
  reportActivitySchema,
  reportJobProgressSchema,
  reportRevenueSchema,
  revokePatronSchema,
  signPaymentSchema,
  submitBidSchema,
  submitJobResultSchema,
  transferSchema,
  updateStatusSchema,
} from "../src/lib/schemas";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("OpenAPI snapshot", () => {
  it("matches the JSON served by /api/docs/openapi.json", async () => {
    const response = GET();
    const spec = await response.json();
    const actual = `${JSON.stringify(spec, null, 2)}\n`;
    const expected = await readFile(
      path.resolve(__dirname, "fixtures/openapi.snapshot.json"),
      "utf8",
    );

    // Normalize line endings to handle Windows CRLF vs Unix LF
    const normalizeLineEndings = (str: string) =>
      str.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    expect(normalizeLineEndings(actual)).toEqual(
      normalizeLineEndings(expected),
    );
  });
});

describe("generated request JSON Schemas", () => {
  const expected = {
    createTalos: ["name", "category", "description", "creatorPublicKey", "signature", "message"],
    reportActivity: ["type", "content"],
    createApproval: ["type", "title"],
    decideApproval: ["status", "decidedBy", "signature", "message"],
    transfer: ["agent", "destination", "asset", "amount", "nonce", "expiry", "signature"],
    becomePatron: ["stellarPublicKey", "pulseAmount", "signature", "message"],
    revokePatron: ["stellarPublicKey", "signature", "message"],
    registerService: ["serviceName", "price"],
    crossChainWebhook: ["talosId", "requesterTalosId", "sourceChain", "paymentReference", "sourceTxHash", "amount"],
    submitBid: [],
    claimJob: [],
    heartbeatJob: ["fencingToken"],
    releaseJob: ["fencingToken"],
    submitJobResult: ["result"],
    reportJobProgress: [],
    reportRevenue: ["amount", "source"],
    recordDividend: ["amount"],
    updateStatus: ["agentOnline"],
    regenerateKey: ["stellarPublicKey", "signature", "message"],
    signPayment: ["payee", "amount"],
    buyToken: ["buyerPublicKey", "amount"],
    createPlaybook: ["title", "category", "price"],
  } as const;
  const schemas = {
    becomePatron: becomePatronSchema,
    buyToken: buyTokenSchema,
    claimJob: claimJobSchema,
    createApproval: createApprovalSchema,
    createPlaybook: createPlaybookSchema,
    createTalos: createTalosSchema,
    crossChainWebhook: crossChainWebhookSchema,
    decideApproval: decideApprovalSchema,
    heartbeatJob: heartbeatJobSchema,
    recordDividend: recordDividendSchema,
    regenerateKey: regenerateKeySchema,
    registerService: registerServiceSchema,
    releaseJob: releaseJobSchema,
    reportActivity: reportActivitySchema,
    reportJobProgress: reportJobProgressSchema,
    reportRevenue: reportRevenueSchema,
    revokePatron: revokePatronSchema,
    signPayment: signPaymentSchema,
    submitBid: submitBidSchema,
    submitJobResult: submitJobResultSchema,
    transfer: transferSchema,
    updateStatus: updateStatusSchema,
  };

  it("generates an object schema with the expected required properties for every request", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(__dirname, "../src/generated/schemas/index.json"), "utf8"),
    ) as { schemas: Array<{ name: string; file: string }> };
    expect(manifest.schemas.map(({ name }) => name).sort()).toEqual(
      Object.keys(schemas).sort(),
    );

    for (const { name, file } of manifest.schemas) {
      const schema = schemas[name as keyof typeof schemas];
      const generated = JSON.parse(
        await readFile(path.join(__dirname, `../src/generated/schemas/${file}`), "utf8"),
      ) as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(generated.type, name).toBe("object");
      expect(Object.keys(generated.properties ?? {}).length, `${name} properties`).toBeGreaterThan(0);
      expect(generated.required ?? [], `${name} required fields`).toEqual(expected[name as keyof typeof expected]);
      expect(
        z.toJSONSchema(schema, {
          target: "draft-07",
          io: "input",
          unrepresentable: "any",
        }),
        `${name} conversion`,
      ).toEqual(generated);
    }
  });
});
