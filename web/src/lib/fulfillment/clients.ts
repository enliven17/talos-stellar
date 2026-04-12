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

  const parts: string[] = [];
  if (data.answer) parts.push(`Summary: ${data.answer}`);
  if (data.results) {
    for (const r of data.results) {
      parts.push(`[${r.title}](${r.url}): ${r.content}`);
    }
  }
  return parts.join("\n\n");
}

// LLM client — Groq preferred (free), OpenAI fallback
export function getLLMClient(): OpenAI {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (groqKey) {
    return new OpenAI({
      apiKey: groqKey,
      baseURL: "https://api.groq.com/openai/v1",
    });
  }
  if (openaiKey) {
    return new OpenAI({ apiKey: openaiKey });
  }
  throw new Error("Neither GROQ_API_KEY nor OPENAI_API_KEY is set");
}

function getLLMModel(): string {
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
