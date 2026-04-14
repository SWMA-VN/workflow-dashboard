// AI wrapper — Gemini free API by default. Swap to Claude API by changing env AI_PROVIDER.

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
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (!r.ok) return `[Gemini error: ${r.status}]`;
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "[no AI response]";
  } catch (e) {
    return `[AI error: ${e.message}]`;
  }
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
