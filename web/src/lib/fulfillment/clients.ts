import OpenAI from "openai";

// Tavily Search API (free tier: 1,000 searches/month)
const TAVILY_BASE = "https://api.tavily.com";

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
  });

  if (!res.ok) {
    throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  // Combine Tavily's answer + source snippets into a single string for GPT
  const parts: string[] = [];
  if (data.answer) {
    parts.push(`Summary: ${data.answer}`);
  }
  if (data.results) {
    for (const r of data.results) {
      parts.push(`[${r.title}](${r.url}): ${r.content}`);
    }
  }

  return parts.join("\n\n");
}

// OpenAI GPT-4o for structured analysis
export function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

export async function analyzeWithGPT(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const openai = getOpenAI();
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  return res.choices[0]?.message?.content ?? "{}";
}
