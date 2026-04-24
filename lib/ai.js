// AI wrapper — Gemini free API by default. Retry on failure. Swap to Claude via env.

export async function aiSummarize(prompt, { maxTokens = 1024 } = {}) {
  const provider = process.env.AI_PROVIDER || "gemini";
  if (provider === "claude") return callClaude(prompt, maxTokens);
  return callGemini(prompt, maxTokens);
}

async function callGemini(prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.AI_MODEL || "gemini-flash-latest";
  if (!apiKey) return "[Gemini key not set]";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
  };

  // Retry up to 3 times with backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }
      if (r.status === 503 || r.status === 429) {
        // Retry after delay
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2000));
        continue;
      }
      return `[Gemini error: ${r.status}]`;
    } catch (e) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      return `[AI error: ${e.message}]`;
    }
  }
  return "[AI unavailable — retries exhausted]";
}

async function callClaude(prompt, maxTokens) {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return "[Claude API key not set]";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return `[Claude error: ${r.status}]`;
    const data = await r.json();
    return data.content?.[0]?.text || "[no response]";
  } catch (e) {
    return `[AI error: ${e.message}]`;
  }
}
