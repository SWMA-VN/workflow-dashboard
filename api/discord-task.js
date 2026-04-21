// POST /api/discord-task
// Discord /task command with:
//   - description (required)
//   - project (optional autocomplete dropdown — shows all org repos)
//   - priority (optional)
//
// If project not picked → AI auto-detects from description.

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

// Cache org repos (5 min)
let _repoCache = null;
let _repoCacheTime = 0;

async function getOrgRepos() {
  if (_repoCache && Date.now() - _repoCacheTime < 300000) return _repoCache;
  const org = process.env.GITHUB_ORG || "SWMA-VN";
  try {
    const r = await fetch(`${GH_API}/orgs/${org}/repos?per_page=100&sort=updated&type=all`, { headers: ghHeaders() });
    if (!r.ok) return _repoCache || [];
    _repoCache = (await r.json()).map((r) => ({ full_name: r.full_name, name: r.name, description: r.description || "", language: r.language || "" }));
    _repoCacheTime = Date.now();
    return _repoCache;
  } catch (e) { return _repoCache || []; }
}

// Keyword repo detection
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
};

function detectRepoByKeywords(text) {
  const t = text.toLowerCase();
  for (const [repo, keywords] of Object.entries(REPO_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return repo;
  }
  return null;
}

async function detectRepoByAI(description, repos) {
  const repoList = repos.map((r) => `${r.name} — ${r.description} (${r.language})`).join("\n");
  const prompt = `Pick the ONE most relevant GitHub repository for this task.
Task: "${description}"
Repos:\n${repoList}
Reply with ONLY the repo name. If unclear, reply "workflow-dashboard".`;
  const result = await aiSummarize(prompt, { maxTokens: 50 });
  const cleaned = result.trim().replace(/["`']/g, "").split("\n")[0].trim();
  const match = repos.find((r) => r.name === cleaned || r.full_name === cleaned);
  return match ? match.name : null;
}

async function registerCommands() {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !botToken) return { error: "Missing env vars" };

  // Delete old /projects command if exists
  try {
    const existing = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    const cmds = await existing.json();
    for (const cmd of cmds) {
      if (cmd.name === "projects") {
        await fetch(`https://discord.com/api/v10/applications/${appId}/commands/${cmd.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bot ${botToken}` },
        });
      }
    }
  } catch (e) {}

  const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "task",
      description: "Create a GitHub task (auto-detects repo + auto-assigns)",
      options: [
        { name: "description", description: "What needs to be done", type: 3, required: true },
        { name: "project", description: "Pick a repo (or leave blank for auto-detect)", type: 3, required: false, autocomplete: true },
        { name: "priority", description: "Priority level", type: 3, required: false,
          choices: [{ name: "P0 — Critical", value: "p0" }, { name: "P1 — High", value: "p1" }, { name: "P2 — Normal", value: "p2" }] },
      ],
    }),
  });
  return { status: r.status, body: await r.text() };
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

  // ===== AUTOCOMPLETE: return repo list as user types =====
  if (body.type === 4) {
    const focused = (body.data.options || []).find((o) => o.focused);
    if (focused && focused.name === "project") {
      const query = (focused.value || "").toLowerCase();
      const repos = await getOrgRepos();
      const filtered = repos
        .filter((r) => {
          if (!query) return true;
          return r.name.toLowerCase().includes(query) ||
                 (r.description || "").toLowerCase().includes(query);
        })
        .slice(0, 25)
        .map((r) => ({
          name: `${r.name}${r.description ? ` — ${r.description.slice(0, 60)}` : ""}`,
          value: r.name,
        }));
      return res.json({ type: 8, data: { choices: filtered } });
    }
    return res.json({ type: 8, data: { choices: [] } });
  }

  // ===== /task command =====
  if (body.type === 2 && body.data?.name === "task") {
    const description = (body.data.options || []).find((o) => o.name === "description")?.value || "";
    const projectPick = (body.data.options || []).find((o) => o.name === "project")?.value || "";
    const priority = (body.data.options || []).find((o) => o.name === "priority")?.value || "p1";
    const author = body.member?.user?.username || body.user?.username || "unknown";

    if (!description) {
      return res.json({ type: 4, data: { content: "Provide a task description.", flags: 64 } });
    }

    const title = description.length > 80 ? description.slice(0, 77) + "..." : description;
    const repos = await getOrgRepos();
    let repoName = null;
    let routeMethod = "default";

    // Priority 1: user picked from dropdown
    if (projectPick) {
      const match = repos.find((r) => r.name === projectPick);
      if (match) { repoName = match.name; routeMethod = "user-selected"; }
    }

    // Priority 2: keyword detection
    if (!repoName) {
      repoName = detectRepoByKeywords(description);
      if (repoName) routeMethod = "keyword-match";
    }

    // Priority 3: AI detection
    if (!repoName && repos.length) {
      repoName = await detectRepoByAI(description, repos);
      if (repoName) routeMethod = "ai-detected";
    }

    if (!repoName) repoName = "workflow-dashboard";
    const fullRepo = `${org}/${repoName}`;

    try {
      const issueBody = `${description}\n\n---\n**Created from Discord** by @${author} via \`/task\`\n**Repo:** ${fullRepo} (${routeMethod})\n**Priority:** ${priority}`;

      const ghRes = await fetch(`${GH_API}/repos/${fullRepo}/issues`, {
        method: "POST",
        headers: ghHeaders(),
        body: JSON.stringify({
          title: description,
          body: issueBody,
          labels: ["discord", priority],
        }),
      });
      if (!ghRes.ok) throw new Error(`GitHub ${ghRes.status}: ${(await ghRes.text()).slice(0, 200)}`);
      const issue = await ghRes.json();

      const branchName = `${issue.number}-${description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;

      return res.json({
        type: 4,
        data: {
          content: [
            `**Task created:** [${repoName}#${issue.number}](${issue.html_url})`,
            `**${description}**`,
            ``,
            `Repo: \`${repoName}\` (${routeMethod})`,
            `Branch: \`${branchName}\``,
            `Priority: ${priority.toUpperCase()}`,
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
