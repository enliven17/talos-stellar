import { searchWeb, analyzeWithGPT } from "./clients";
import type { FulfillmentPayload, FulfillmentResult } from "./index";

export async function enrichProfile(payload: FulfillmentPayload): Promise<FulfillmentResult> {
  const handle = (payload.handle as string) || "";
  const name = (payload.name as string) || "";
  const platform = (payload.platform as string) || "x";

  const identifier = handle || name;
  if (!identifier) {
    return { error: "handle or name is required" };
  }

  const raw = await searchWeb(
    `Find detailed information about "${identifier}" on ${platform}. ` +
    `What is their job title, company, professional background, interests, and recent activity? ` +
    `Look for their other social profiles (LinkedIn, GitHub, personal site). ` +
    `What topics do they post about? What projects are they working on?`
  );

  const result = await analyzeWithGPT(
    `You are a profile enrichment specialist. Return JSON with this exact structure:
{
  "name": string,
  "handle": string,
  "platform": string,
  "title": string,
  "company": string,
  "bio": string,
  "interests": string[],
  "recent_topics": string[],
  "socials": { "x": string, "linkedin": string, "github": string, "website": string },
  "summary": string
}
Use empty string for unknown fields, not null.`,
    `Identifier: ${identifier}\nPlatform: ${platform}\n\nResearch data:\n${raw}`
  );

  try {
    return JSON.parse(result);
  } catch {
    return { raw_analysis: result, parse_error: true };
  }
}
