import OpenAI from "openai";

// Tavily Search API (free tier: 1,000 searches/month)
const TAVILY_BASE = "https://api.tavily.com";

/**
 * Maximum time (ms) to wait for a Tavily response before aborting.
 * Prevents the fulfillment pipeline from hanging on slow network conditions.
 */
export const TAVILY_TIMEOUT_MS = 10_000;

/**
 * Maximum characters kept per individual search result's content field.
 * Prevents a single verbose result from dominating the LLM prompt.
 */
export const TAVILY_RESULT_CONTENT_MAX_CHARS = 1_000;

/**
 * Maximum total characters of the joined search output passed to the LLM.
 * Caps the overall prompt contribution regardless of how many results Tavily returns.
 */
export const TAVILY_OUTPUT_MAX_CHARS = 8_000;

export async function searchWeb(query: string): Promise<string> {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not set");
  }

  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      include_answer: true,
      max_results: 5,
    }),
    // Abort the request if Tavily has not responded within the timeout window.
    signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const parts: string[] = [];
  if (data.answer) parts.push(`Summary: ${data.answer}`);
  if (data.results) {
    for (const r of data.results) {
      // Truncate per-result content to avoid a single result ballooning the prompt.
      const content: string =
        typeof r.content === "string" &&
        r.content.length > TAVILY_RESULT_CONTENT_MAX_CHARS
          ? r.content.slice(0, TAVILY_RESULT_CONTENT_MAX_CHARS) + "…"
          : (r.content ?? "");
      parts.push(`[${r.title}](${r.url}): ${content}`);
    }
  }

  const joined = parts.join("\n\n");

  // Hard-cap total output so the LLM prompt never grows unbounded.
  if (joined.length > TAVILY_OUTPUT_MAX_CHARS) {
    return joined.slice(0, TAVILY_OUTPUT_MAX_CHARS) + "…";
  }
  return joined;
}

let cachedGroqClient: OpenAI | null = null;
let cachedGroqKey: string | null = null;
let cachedOpenAIClient: OpenAI | null = null;
let cachedOpenAIKey: string | null = null;

export function resetLLMClients(): void {
  cachedGroqClient = null;
  cachedGroqKey = null;
  cachedOpenAIClient = null;
  cachedOpenAIKey = null;
}

// LLM client — Groq preferred (free), OpenAI fallback
export function getLLMClient(): OpenAI {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (groqKey) {
    if (!cachedGroqClient || cachedGroqKey !== groqKey) {
      cachedGroqClient = new OpenAI({
        apiKey: groqKey,
        baseURL: "https://api.groq.com/openai/v1",
      });
      cachedGroqKey = groqKey;
    }
    return cachedGroqClient;
  }
  if (openaiKey) {
    if (!cachedOpenAIClient || cachedOpenAIKey !== openaiKey) {
      cachedOpenAIClient = new OpenAI({ apiKey: openaiKey });
      cachedOpenAIKey = openaiKey;
    }
    return cachedOpenAIClient;
  }
  throw new Error("Neither GROQ_API_KEY nor OPENAI_API_KEY is set");
}

export function getLLMModel(): string {
  const override = process.env.FULFILLMENT_LLM_MODEL?.trim();
  if (override) {
    return override;
  }
  return process.env.GROQ_API_KEY ? "llama-3.3-70b-versatile" : "gpt-4o";
}

export async function analyzeWithGPT(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const client = getLLMClient();
  const res = await client.chat.completions.create({
    model: getLLMModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content ?? "{}";
}
