import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function audienceInsight(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const product = (payload.product as string) || "unknown product";
  const category = (payload.category as string) || "";

  const raw = await searchWeb(
    `Who is the target audience for "${product}"${category ? ` in the ${category} category` : ""}? ` +
    `Describe their demographics, pain points, where they hang out online (communities, social platforms, forums), ` +
    `and what content resonates with them. Be specific with platform names and community URLs.`
  );

  const result = await analyzeWithGPT(
    `You are an audience research analyst. Return JSON with this exact structure:
{
  "personas": [{ "name": string, "description": string, "pain_points": string[] }],
  "communities": [{ "platform": string, "name": string, "url": string, "relevance": string }],
  "channels": [{ "platform": string, "strategy": string }],
  "key_pain_points": string[]
}`,
    `Product: ${product}\nCategory: ${category}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
