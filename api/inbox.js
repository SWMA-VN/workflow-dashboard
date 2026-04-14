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

// Fetch all existing issues (open + recently closed) to detect duplicates
async function fetchExistingIssues() {
  const repo = process.env.GITHUB_REPO;
  const org = process.env.GITHUB_ORG;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
  const issues = [];
  try {
    // Open issues
    const target = org ? `/search/issues?q=org:${org}+is:issue+is:open&per_page=100` : `/repos/${repo}/issues?state=open&per_page=100`;
    const r1 = await fetch(`${GH_API}${target}`, { headers });
    if (r1.ok) {
      const d = await r1.json();
      const items = d.items || d;
      for (const i of items) if (!i.pull_request) issues.push({ number: i.number, title: i.title, state: "open" });
    }
    // Recently closed (last 30 days)
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const closedTarget = org
      ? `/search/issues?q=org:${org}+is:issue+is:closed+updated:>=${since.slice(0,10)}&per_page=100`
      : `/repos/${repo}/issues?state=closed&since=${since}&per_page=100`;
    const r2 = await fetch(`${GH_API}${closedTarget}`, { headers });
    if (r2.ok) {
      const d = await r2.json();
      const items = d.items || d;
      for (const i of items) if (!i.pull_request) issues.push({ number: i.number, title: i.title, state: "closed" });
    }
  } catch (e) {
    console.error("[inbox] Error fetching existing issues:", e.message);
  }
  return issues;
}

// Extract action items via AI, returns [{title, body, labels, priority}]
async function extractActionItems(content, title, aiAvailable) {
  // Fetch existing issues for deduplication
  const existing = await fetchExistingIssues();
  const existingList = existing.map((i) => `#${i.number} [${i.state.toUpperCase()}] ${i.title}`).join("\n");

  if (aiAvailable) {
    const prompt = `You are a PM assistant. From the following document, extract ACTIONABLE tasks for a dev team.

Document title: "${title}"

Document content:
---
${content.slice(0, 18000)}
---

EXISTING ISSUES IN THE SYSTEM (do NOT create duplicates of these):
---
${existingList || "(no existing issues)"}
---

For each NEW action item that does NOT already exist above, output EXACTLY this JSON format (array of objects):
[
  {
    "title": "Short task title (imperative, like a GitHub issue title)",
    "body": "Description with acceptance criteria. 2-3 sentences max.",
    "labels": ["one-of: frontend, backend, mobile, payment, qa, devops, integration"],
    "priority": "P0 or P1 or P2"
  }
]

CRITICAL RULES:
- SKIP any task that is already covered by an existing issue above (open or closed). Use semantic matching, not just exact title match. For example, if existing has "Fix HitPay checkout bug" and doc says "resolve payment flow issue", that's the SAME task — skip it.
- SKIP any task that is clearly already completed (existing issue is CLOSED).
- ALL titles and descriptions MUST be in ENGLISH. If the source text is Vietnamese or any other language, TRANSLATE to English.
- Title format: imperative, specific (not "do the thing" but "Add payment validation to checkout form")
- Body: full clear description with acceptance criteria so a developer can work on it without asking questions. Include: what to build, expected behavior, edge cases if any.
- Only include ACTIONABLE items (not observations or questions)
- Each item should be assignable to ONE developer
- If ALL items already exist or are completed, return an empty array []
- Maximum 10 items per document
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
// === GET handler: submission history ===
async function handleHistory(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    const repo = process.env.GITHUB_REPO;
    const org = process.env.GITHUB_ORG;
    let items = [];
    if (org) {
      const r = await ghGet2(`/search/issues?q=org:${org}+label:inbox-history+is:closed&sort=created&order=desc&per_page=50`);
      items = r.items || [];
    } else if (repo) {
      items = await ghGet2(`/repos/${repo}/issues?labels=inbox-history&state=closed&sort=created&direction=desc&per_page=50`);
    }
    const history = items.map((issue) => {
      const body = issue.body || "";
      const titleMatch = body.match(/\*\*Title\*\*\s*\|\s*(.+)/);
      const typeMatch = body.match(/\*\*Type\*\*\s*\|\s*`([^`]+)`/);
      const sourceMatch = body.match(/\*\*Source\*\*\s*\|\s*(.+)/);
      const submittedMatch = body.match(/\*\*Submitted\*\*\s*\|\s*(.+)/);
      const aiMatch = body.match(/\*\*AI used\*\*\s*\|\s*(.+)/);
      const createdMatch = body.match(/\*\*Issues created\*\*\s*\|\s*(\d+)/);
      const taskRefs = [...body.matchAll(/#(\d+)\s*—\s*(.+?)(?:\(|$)/gm)];
      const tasks = taskRefs.map((m) => ({
        number: parseInt(m[1]),
        title: m[2].trim(),
        url: `https://github.com/${repo || "SWMA-VN/workflow-dashboard"}/issues/${m[1]}`,
      }));
      return {
        log_number: issue.number, log_url: issue.html_url,
        document_title: titleMatch ? titleMatch[1].trim() : issue.title.replace("[INBOX-LOG] ", ""),
        doc_type: typeMatch ? typeMatch[1] : "unknown",
        source: sourceMatch ? sourceMatch[1].trim() : "",
        submitted_at: submittedMatch ? submittedMatch[1].trim() : issue.created_at,
        ai_used: aiMatch ? aiMatch[1].trim() : "unknown",
        issues_created: createdMatch ? parseInt(createdMatch[1]) : tasks.length,
        tasks,
      };
    });
    res.json({ generated_at: new Date().toISOString(), total: history.length, history });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

async function ghGet2(path) {
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

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
  // GET = return submission history, POST = process new document
  if (req.method === "GET") return handleHistory(req, res);
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

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
        message: "No NEW actionable items found. All tasks from this document either already exist as issues or have been completed.",
        issues_created: 0,
        existing_issues_checked: existing.length,
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
      const issueBody = `${item.body || ""}\n\n---\n📥 **Auto-created from Inbox**\n**Source document:** ${title}\n**Priority:** ${item.priority || "P1"}\n**Labels:** ${(item.labels || []).join(", ") || "none"}\n**Source URL:** ${url || "_pasted text_"}`;

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

    // Step 4: Create history tracking issue (stores what was submitted + what was created)
    let trackingIssue = null;
    if (successCount > 0) {
      const issueLinks = created.filter((c) => c.number)
        .map((c) => `- [x] #${c.number} — ${c.title} (${(c.labels || []).join(", ")})`).join("\n");

      const contentPreview = text.slice(0, 1500).replace(/`/g, "'");
      const now = new Date().toISOString();
      const docType = url ? (url.includes("spreadsheets") ? "google-sheet" : url.includes("document") ? "google-doc" : "url") : "pasted-text";

      const trackBody = `## Inbox Submission Log

| Field | Value |
|---|---|
| **Title** | ${title} |
| **Type** | \`${docType}\` |
| **Source** | ${url || "_pasted text_"} |
| **Submitted** | ${now} |
| **AI used** | ${aiAvailable ? "Yes (Gemini)" : "No (basic extraction)"} |
| **Items extracted** | ${items.length} |
| **Issues created** | ${successCount} |

### Generated Tasks

${issueLinks}

### Document Preview (first 1500 chars)

\`\`\`
${contentPreview}
\`\`\`

---
_Auto-generated by PM Command Center Inbox_`;

      try {
        trackingIssue = await ghPost(`/repos/${targetRepo}/issues`, {
          title: `[INBOX-LOG] ${title} (${successCount} tasks)`,
          body: trackBody,
          labels: ["inbox-history"],
        });
        // Close immediately — it's a log, not a task
        await fetch(`${GH_API}/repos/${targetRepo}/issues/${trackingIssue.number}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state: "closed" }),
        });
      } catch (e) {
        console.error("[inbox] Failed to create tracking issue:", e.message);
      }
    }

    // Step 5: Discord notification
    const issueList = created
      .filter((c) => c.number)
      .map((c) => `• [#${c.number}](${c.url}) ${c.title}`)
      .join("\n");

    await postDiscord({
      content: `**Inbox processed:** ${title}`,
      embeds: [
        makeEmbed({
          title: `${successCount} new issues created from "${title}"`,
          description: issueList || "No new issues created (all tasks already exist).",
          fields: [
            { name: "Source", value: sourceLabel.slice(0, 200), inline: true },
            { name: "Method", value: aiAvailable ? "AI extraction (with dedup)" : "Basic extraction", inline: true },
            { name: "Existing checked", value: `${existing.length} issues scanned for duplicates`, inline: true },
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
      existing_issues_checked: existing.length,
      items_extracted: items.length,
      issues_created: successCount,
      issues: created,
      tracking_issue: trackingIssue ? { number: trackingIssue.number, url: trackingIssue.html_url } : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
