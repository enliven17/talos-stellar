import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function findLeads(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const product = (payload.product as string) || "unknown product";
  const target = (payload.target as string) || "potential customers";
  const sources = (payload.sources as string[]) || ["x", "reddit", "github"];

  const sourceStr = sources.join(", ");

  const raw = await searchWeb(
    `Find people on ${sourceStr} who might be interested in "${product}". ` +
    `Target profile: ${target}. ` +
    `Look for people who have recently posted about related topics, asked questions about similar tools, ` +
    `or expressed frustration with existing solutions. Include their usernames/handles and what they said.`
  );

  const result = await analyzeWithGPT(
    `You are a lead generation specialist. Return JSON with this exact structure:
{
  "leads": [{ "name": string, "handle": string, "platform": string, "title": string, "relevance_score": number, "reason": string, "recent_activity": string }],
  "search_summary": string,
  "recommended_approach": string
}
relevance_score is 0-1. Include up to 10 leads sorted by relevance.`,
    `Product: ${product}\nTarget: ${target}\nSources: ${sourceStr}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
