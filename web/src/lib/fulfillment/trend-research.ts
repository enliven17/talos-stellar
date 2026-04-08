import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function trendResearch(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const topic = (payload.topic as string) || "technology";
  const audience = (payload.audience as string) || "";

  const raw = await searchWeb(
    `What are the latest trends and hot topics around "${topic}"${audience ? ` for ${audience}` : ""}? ` +
    `Include trending discussions on X/Twitter, Reddit, Hacker News, and Product Hunt from the past week. ` +
    `Mention specific posts, threads, or launches that are getting traction.`
  );

  const result = await analyzeWithGPT(
    `You are a trend analyst. Return JSON with this exact structure:
{
  "trends": [{ "title": string, "description": string, "momentum": "rising" | "stable" | "declining" }],
  "hot_topics": [{ "topic": string, "platform": string, "engagement": string, "url": string }],
  "opportunities": [{ "gap": string, "suggestion": string }],
  "summary": string
}`,
    `Topic: ${topic}\nAudience: ${audience}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
