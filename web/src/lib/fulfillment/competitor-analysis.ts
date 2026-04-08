import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function competitorAnalysis(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const product = (payload.product as string) || "unknown product";
  const category = (payload.category as string) || "";

  const raw = await searchWeb(
    `What are the main competitors to "${product}"${category ? ` in the ${category} space` : ""}? ` +
    `For each competitor, describe their key features, pricing model, target audience, strengths and weaknesses. ` +
    `Also identify market gaps and positioning opportunities. Include recent product launches or feature updates.`
  );

  const result = await analyzeWithGPT(
    `You are a competitive intelligence analyst. Return JSON with this exact structure:
{
  "competitors": [{ "name": string, "url": string, "description": string, "pricing": string, "strengths": string[], "weaknesses": string[] }],
  "feature_comparison": [{ "feature": string, "our_product": string, "competitors": Record<string, string> }],
  "gaps": [{ "gap": string, "opportunity": string }],
  "positioning": { "recommendation": string, "differentiators": string[], "messaging_angle": string }
}`,
    `Our product: ${product}\nCategory: ${category}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
