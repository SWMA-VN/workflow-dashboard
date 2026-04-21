// POST /api/discord-task
// Discord slash commands: /task and /projects
//
// /task <description> [project:<repo>] [priority:P0/P1/P2]
//   → AI detects correct repo from description (or user specifies)
//   → Creates issue in that repo
//   → Auto-assign fires
//   → Discord responds with repo + branch name
//
// /projects
//   → Lists all repos in the org

import nacl from "tweetnacl";
import { aiSummarize } from "../lib/ai.js";

export const config = { api: { bodyParser: false } };

const GH_API = "https://api.github.com";

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyDiscord(body, signature, timestamp, publicKey) {
  try {
    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp), body]),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex"),
    );
  } catch {
    return false;
  }
}

// Fetch org repos for routing
async function fetchOrgRepos() {
  const org = process.env.GITHUB_ORG || "SWMA-VN";
  try {
    const r = await fetch(`${GH_API}/orgs/${org}/repos?per_page=100&sort=updated&type=all`, { headers: ghHeaders() });
    if (!r.ok) return [];
    const repos = await r.json();
    return repos.map((r) => ({ full_name: r.full_name, name: r.name, description: r.description || "", language: r.language || "" }));
  } catch (e) { return []; }
}

// Keyword-based repo detection (fast fallback when AI unavailable)
const REPO_KEYWORDS = {
  "ai-success-2.0": ["ai success", "hot lead", "crm", "chatbot", "gamification", "partner crm", "ai solomon", "goal", "leaderboard"],
  "swma-enrollment": ["enrollment", "enroll", "hitpay", "bydesign", "signup", "partner registration"],
  "swma-mobile": ["mobile app", "ios app", "android app", "react native", "psaim app", "watch face"],
  "swma-medusajs-server": ["medusa server", "medusa backend", "medusa api", "e-commerce backend", "order sync"],
  "swma-medusajs-storefront": ["medusa storefront", "medusa frontend", "shop page", "product page"],
  "swm-warehouse": ["warehouse", "inventory", "stock"],
  "swma-sw": ["shopware", "shopware6"],
  "psaim": ["psaim", "health dashboard", "vitals", "wellness"],
  "recommendations": ["recommendation", "health product"],
  "swma-laravel": ["laravel"],
};

function detectRepoByKeywords(text) {
  const t = text.toLowerCase();
  for (const [repo, keywords] of Object.entries(REPO_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return repo;
  }
  return null;
}

// AI-based repo detection
async function detectRepoByAI(description, repos) {
  const repoList = repos.map((r) => `${r.name} — ${r.description} (${r.language})`).join("\n");
  const prompt = `Pick the ONE most relevant GitHub repository for this task.

Task: "${description}"

Available repos:
${repoList}

Reply with ONLY the repo name (e.g., "ai-success-2.0"), nothing else. If unclear, reply "workflow-dashboard".`;

  const result = await aiSummarize(prompt, { maxTokens: 50 });
  const cleaned = result.trim().replace(/["`']/g, "").split("\n")[0].trim();
  // Validate against actual repos
  const match = repos.find((r) => r.name === cleaned || r.full_name === cleaned);
  return match ? match.name : null;
}

// Parse "project:RepoName" from description
function parseProjectTag(description) {
  // Match patterns: "project:ai-success" or ":AI Success" at end
  const match = description.match(/(?:project:|:)([a-zA-Z0-9\-_ ]+)\s*$/i);
  if (!match) return { cleanDesc: description, projectHint: null };
  const hint = match[1].trim();
  const cleanDesc = description.replace(match[0], "").trim();
  return { cleanDesc, projectHint: hint };
}

// Match project hint to actual repo
function matchHintToRepo(hint, repos) {
  const h = hint.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Try direct name match
  const direct = repos.find((r) => r.name.toLowerCase().replace(/[^a-z0-9]/g, "") === h);
  if (direct) return direct.name;
  // Try partial match
  const partial = repos.find((r) => r.name.toLowerCase().includes(h) || h.includes(r.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (partial) return partial.name;
  // Try description match
  const descMatch = repos.find((r) => r.description.toLowerCase().includes(hint.toLowerCase()));
  if (descMatch) return descMatch.name;
  return null;
}

async function registerCommands() {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !botToken) return { error: "Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN" };

  const commands = [
    {
      name: "task",
      description: "Create a GitHub task (auto-detects repo + auto-assigns)",
      options: [
        { name: "description", description: "What needs to be done (add ':ProjectName' at end to specify repo)", type: 3, required: true },
        { name: "priority", description: "Priority level", type: 3, required: false,
          choices: [{ name: "P0", value: "p0" }, { name: "P1", value: "p1" }, { name: "P2", value: "p2" }] },
      ],
    },
    {
      name: "projects",
      description: "List all repos in the organization",
    },
  ];

  const results = [];
  for (const cmd of commands) {
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    results.push({ name: cmd.name, status: r.status });
  }
  return results;
}

export default async function handler(req, res) {
  if (req.query?.register === "1") return res.json(await registerCommands());
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) return res.status(500).json({ error: "DISCORD_PUBLIC_KEY not set" });
  if (!signature || !timestamp) return res.status(401).end();
  if (!verifyDiscord(raw, signature, timestamp, publicKey)) return res.status(401).send("invalid signature");

  const body = JSON.parse(raw.toString());
  if (body.type === 1) return res.json({ type: 1 });

  const org = process.env.GITHUB_ORG || "SWMA-VN";

  // ===== /projects command =====
  if (body.type === 2 && body.data?.name === "projects") {
    const repos = await fetchOrgRepos();
    const list = repos.slice(0, 25).map((r) =>
      `**${r.name}** — ${r.description || r.language || "no description"}`
    ).join("\n");
    return res.json({
      type: 4,
      data: { content: `**Repos in ${org}** (${repos.length} total):\n\n${list}` },
    });
  }

  // ===== /task command =====
  if (body.type === 2 && body.data?.name === "task") {
    const rawDesc = (body.data.options || []).find((o) => o.name === "description")?.value || "";
    const priority = (body.data.options || []).find((o) => o.name === "priority")?.value || "p1";
    const author = body.member?.user?.username || body.user?.username || "unknown";
    const channelName = body.channel?.name || "";

    if (!rawDesc) {
      return res.json({ type: 4, data: { content: "Provide a task description.", flags: 64 } });
    }

    // Parse optional project tag from description
    const { cleanDesc, projectHint } = parseProjectTag(rawDesc);
    const title = cleanDesc.length > 80 ? cleanDesc.slice(0, 77) + "..." : cleanDesc;

    // Detect correct repo
    const repos = await fetchOrgRepos();
    let repoName = null;
    let routeMethod = "default";

    // Priority 1: user-specified project tag
    if (projectHint) {
      repoName = matchHintToRepo(projectHint, repos);
      if (repoName) routeMethod = "user-specified";
    }

    // Priority 2: keyword detection from description + channel name
    if (!repoName) {
      repoName = detectRepoByKeywords(`${cleanDesc} ${channelName}`);
      if (repoName) routeMethod = "keyword-match";
    }

    // Priority 3: AI detection
    if (!repoName && repos.length) {
      repoName = await detectRepoByAI(cleanDesc, repos);
      if (repoName) routeMethod = "ai-detected";
    }

    // Fallback
    if (!repoName) repoName = "workflow-dashboard";
    const fullRepo = `${org}/${repoName}`;

    try {
      const issueBody = `${cleanDesc}\n\n---\n**Created from Discord** by @${author} via \`/task\`\n**Repo:** ${fullRepo} (${routeMethod})\n**Priority:** ${priority}`;

      const ghRes = await fetch(`${GH_API}/repos/${fullRepo}/issues`, {
        method: "POST",
        headers: ghHeaders(),
        body: JSON.stringify({
          title: cleanDesc,
          body: issueBody,
          labels: ["discord", priority],
        }),
      });
      if (!ghRes.ok) throw new Error(`GitHub ${ghRes.status}: ${await ghRes.text()}`);
      const issue = await ghRes.json();

      const branchName = `${issue.number}-${cleanDesc.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;

      return res.json({
        type: 4,
        data: {
          content: [
            `**Task created:** [${repoName}#${issue.number}](${issue.html_url})`,
            `**${cleanDesc}**`,
            ``,
            `Repo: \`${repoName}\` (${routeMethod})`,
            `Branch: \`${branchName}\``,
            `Priority: ${priority.toUpperCase()}`,
            ``,
            `Auto-assign picking the right dev now.`,
          ].join("\n"),
        },
      });
    } catch (e) {
      return res.json({ type: 4, data: { content: `Failed: ${e.message}`, flags: 64 } });
    }
  }

  res.json({ type: 1 });
}
