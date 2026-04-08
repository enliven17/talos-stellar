import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function intentSignal(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const topic = (payload.topic as string) || "unknown topic";
  const sources = (payload.sources as string[]) || ["x", "reddit"];
  const product = (payload.product as string) || "";

  const sourceStr = sources.join(", ");

  const raw = await searchWeb(
    `"${topic}" site:reddit.com OR site:x.com "looking for" OR "anyone recommend" OR "alternatives to" OR "switching from"`,
  );

  const result = await analyzeWithGPT(
    `You are an intent signal analyst. Return JSON with this exact structure:
{
  "signals": [{ "user": string, "handle": string, "platform": string, "content_snippet": string, "intent_type": "seeking" | "switching" | "frustrated" | "evaluating" | "recommending", "intent_score": number, "url": string, "posted_at": string }],
  "summary": string,
  "recommended_actions": [{ "signal_user": string, "action": string, "message_template": string }]
}
intent_score is 0-1. Sort by intent_score descending. Include up to 10 signals.`,
    `Topic: ${topic}\nProduct: ${product}\nSources: ${sourceStr}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
