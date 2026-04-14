// POST /api/inbox
// The "one place" — drop any doc/text/URL here and the system:
//   1. Fetches content (if URL)
//   2. AI extracts action items
//   3. Creates a GitHub issue per action item (with labels + skill hints)
//   4. Auto-assign fires on each issue via webhook
//   5. Posts summary to Discord
//
// Body: { type: "text"|"sheet"|"url", content: "...", title: "..." }

import { scope } from "../lib/github.js";
import { fetchSheet } from "../lib/sheets.js";
import { aiSummarize } from "../lib/ai.js";
import { postDiscord, makeEmbed } from "../lib/discord.js";

const GH_API = "https://api.github.com";

async function ghPost(path, body) {
  const r = await fetch(`${GH_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return r.json();
}

// Fetch content from a URL (Google Sheet CSV, or generic page text)
async function fetchContent(url) {
  // Google Sheet → convert to CSV export
  const sheetMatch = url.match(/\/spreadsheets\/d\/([^\/]+)/);
  if (sheetMatch) {
    const id = sheetMatch[1];
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    const csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const r = await fetch(csvUrl, { redirect: "follow" });
    if (r.ok) return await r.text();
  }
  // Google Doc → try export as text
  const docMatch = url.match(/\/document\/d\/([^\/]+)/);
  if (docMatch) {
    const id = docMatch[1];
    const txtUrl = `https://docs.google.com/document/d/${id}/export?format=txt`;
    const r = await fetch(txtUrl, { redirect: "follow" });
    if (r.ok) return await r.text();
  }
  // Generic URL
  const r = await fetch(url, { redirect: "follow" });
  if (r.ok) {
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text") || ct.includes("json") || ct.includes("csv")) {
      return await r.text();
    }
  }
  return null;
}

// Extract action items via AI, returns [{title, body, labels, priority}]
async function extractActionItems(content, title, aiAvailable) {
  if (aiAvailable) {
    const prompt = `You are a PM assistant. From the following document, extract ACTIONABLE tasks for a dev team.

Document title: "${title}"

Document content:
---
${content.slice(0, 20000)}
---

For each action item, output EXACTLY this JSON format (array of objects):
[
  {
    "title": "Short task title (imperative, like a GitHub issue title)",
    "body": "Description with acceptance criteria. 2-3 sentences max.",
    "labels": ["one-of: frontend, backend, mobile, payment, qa, devops, integration"],
    "priority": "P0 or P1 or P2"
  }
]

Rules:
- Only include ACTIONABLE items (not observations or questions)
- Each item should be assignable to ONE developer
- If no clear action items exist, return an empty array []
- Maximum 10 items per document
- Make titles specific (not "do the thing" but "Add payment validation to checkout form")
- Labels should be the best skill category for routing to the right dev

Return ONLY the JSON array, no markdown, no explanation.`;

    const raw = await aiSummarize(prompt, { maxTokens: 3000 });
    try {
      // Try to parse JSON from AI response (strip markdown fences if present)
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const items = JSON.parse(cleaned);
      if (Array.isArray(items)) return items.slice(0, 10);
    } catch (e) {
      // AI returned non-JSON; fall back to basic extraction
    }
  }

  // Fallback: basic line-by-line extraction (no AI)
  return extractBasic(content, title);
}

// Basic extraction without AI: split by bullet points / numbered lists
function extractBasic(content, title) {
  const lines = content.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    // Match lines starting with - [ ], *, -, or numbered (1. 2.)
    const m = line.match(/^(?:[-*]|\d+[.)]\s*|\[[ x]\]\s*)(.*)/i);
    if (m && m[1].length > 10 && m[1].length < 300) {
      items.push({
        title: m[1].slice(0, 120),
        body: `Extracted from: "${title}"\n\nOriginal line: ${line}`,
        labels: [],
        priority: "P1",
      });
    }
  }
  return items.slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const { type, content, url, title = "Untitled document" } = req.body || {};

    if (!content && !url) {
      return res.status(400).json({ error: "Provide 'content' (text) or 'url' (link to fetch)" });
    }

    // Step 1: Get the text content
    let text = content || "";
    let sourceLabel = "pasted text";

    if (url) {
      sourceLabel = url;
      const fetched = await fetchContent(url);
      if (fetched) {
        text = fetched;
      } else {
        return res.status(400).json({ error: `Could not fetch content from URL: ${url}` });
      }
    }

    if (!text.trim()) {
      return res.status(400).json({ error: "No text content found" });
    }

    // Step 2: Extract action items
    const aiAvailable = !!process.env.GEMINI_API_KEY || !!process.env.CLAUDE_API_KEY;
    const items = await extractActionItems(text, title, aiAvailable);

    if (!items.length) {
      return res.json({
        ok: true,
        message: "No actionable items found in this document.",
        issues_created: 0,
        source: sourceLabel,
      });
    }

    // Step 3: Create GitHub issues
    const repo = process.env.GITHUB_REPO;
    const org = process.env.GITHUB_ORG;
    const targetRepo = repo || (org ? `${org}/workflow-dashboard` : null);

    if (!targetRepo) {
      return res.status(500).json({ error: "No GITHUB_REPO or GITHUB_ORG configured" });
    }

    const created = [];
    for (const item of items) {
      const issueBody = `${item.body || ""}\n\n---\n📥 Auto-created from inbox\n**Source:** ${title}\n**Priority:** ${item.priority || "P1"}\n**Labels:** ${(item.labels || []).join(", ") || "none"}`;

      const labels = [...(item.labels || [])];
      if (item.priority) labels.push(item.priority.toLowerCase());
      labels.push("inbox");

      try {
        const issue = await ghPost(`/repos/${targetRepo}/issues`, {
          title: `[INBOX] ${item.title}`,
          body: issueBody,
          labels: labels.filter(Boolean),
        });
        created.push({
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          labels,
        });
      } catch (e) {
        created.push({ error: e.message, title: item.title });
      }
    }

    const successCount = created.filter((c) => c.number).length;

    // Step 4: Discord notification
    const issueList = created
      .filter((c) => c.number)
      .map((c) => `• [#${c.number}](${c.url}) ${c.title}`)
      .join("\n");

    await postDiscord({
      content: `📥 **Inbox processed:** ${title}`,
      embeds: [
        makeEmbed({
          title: `📥 ${successCount} issues created from "${title}"`,
          description: issueList || "No issues created.",
          fields: [
            { name: "Source", value: sourceLabel.slice(0, 200), inline: true },
            { name: "Method", value: aiAvailable ? "AI extraction" : "Basic extraction (no AI key)", inline: true },
          ],
          color: 0x9B59B6,
        }),
      ],
    });

    // Note: auto-assign fires automatically via webhook when issues are created
    // (webhook is triggered by GitHub, not by us — so there may be a 1-5 sec delay)

    res.json({
      ok: true,
      source: sourceLabel,
      title,
      ai_used: aiAvailable,
      items_extracted: items.length,
      issues_created: successCount,
      issues: created,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
