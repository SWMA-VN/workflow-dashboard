// POST /api/webhook
// GitHub webhook receiver.
// - NO auto-assign (removed — PM assigns manually)
// - NO actions on @vamadeus issues (client — completely ignored)
// - Status tracking only for team-created issues
// - Discord notifications for key events

import crypto from "node:crypto";
import { postDiscord, makeEmbed } from "../lib/discord.js";

export const config = { api: { bodyParser: false } };

const GH_API = "https://api.github.com";
const STATUS_LABELS = ["status:in-progress", "status:in-review", "status:testing"];

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifySignature(payload, signature, secret) {
  if (!secret) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ""), Buffer.from(expected));
  } catch {
    return false;
  }
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function setStatusLabel(repo, issueNumber, newStatus) {
  try {
    const r = await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels`, { headers: ghHeaders() });
    if (!r.ok) return;
    const labels = await r.json();
    const currentStatus = labels.filter((l) => STATUS_LABELS.includes(l.name));
    for (const old of currentStatus) {
      if (old.name !== newStatus) {
        await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(old.name)}`, {
          method: "DELETE", headers: ghHeaders(),
        });
      }
    }
    if (newStatus && !currentStatus.some((l) => l.name === newStatus)) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels`, {
        method: "POST", headers: ghHeaders(),
        body: JSON.stringify({ labels: [newStatus] }),
      });
    }
  } catch (e) {
    console.error(`[webhook] setStatusLabel error for #${issueNumber}:`, e.message);
  }
}

async function clearStatusLabels(repo, issueNumber) {
  try {
    for (const label of [...STATUS_LABELS, "Block"]) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE", headers: ghHeaders(),
      }).catch(() => {});
    }
  } catch (e) {}
}

// Parse issue numbers from PR body + branch name
async function parseIssueRefs(pr, repo) {
  const text = `${pr.title || ""} ${pr.body || ""}`;
  const matches = [...text.matchAll(/(?:closes?|fixes?|resolves?|refs?)?\s*#(\d+)/gi)];
  const nums = new Set(matches.map((m) => parseInt(m[1])));
  const branch = pr.head?.ref || "";
  const branchMatch = branch.match(/(?:^|[\/\-_])(\d+)(?:[\/\-_]|$)/);
  if (branchMatch) nums.add(parseInt(branchMatch[1]));
  return [...nums].filter((n) => n !== pr.number && n > 0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!verifySignature(raw, signature, secret)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let body;
  try {
    body = JSON.parse(raw.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = req.headers["x-github-event"];
  const repo = body.repository?.full_name || process.env.GITHUB_REPO;
  const excludedUsers = (process.env.EXCLUDED_USERS || "vamadeus").split(",").map((s) => s.trim().toLowerCase());

  // === IGNORE ALL EVENTS FROM EXCLUDED USERS (client) ===
  const actor = (body.sender?.login || "").toLowerCase();
  if (excludedUsers.includes(actor)) {
    return res.json({ ok: true, skipped: true, reason: `actor ${actor} is excluded` });
  }

  // Also skip if issue was created by excluded user
  const issueCreator = (body.issue?.user?.login || body.pull_request?.user?.login || "").toLowerCase();
  if (event === "issues" && excludedUsers.includes(issueCreator)) {
    return res.json({ ok: true, skipped: true, reason: `issue creator ${issueCreator} is excluded` });
  }

  console.log(`[webhook] ${event} ${body.action} repo:${repo} actor:${actor}`);

  // ========================================
  // ISSUES EVENTS (no auto-assign)
  // ========================================
  if (event === "issues") {
    const issue = body.issue;
    const issueNum = issue.number;

    // Assigned: move to In Progress
    if (body.action === "assigned") {
      await setStatusLabel(repo, issueNum, "status:in-progress");
    }

    // Closed: clear status labels
    if (body.action === "closed") {
      await clearStatusLabels(repo, issueNum);
    }

    // Blocked label added
    if (body.action === "labeled") {
      const label = body.label?.name?.toLowerCase() || "";
      if (label === "block" || label === "blocked" || label === "blocker") {
        await postDiscord({
          content: "**BLOCKER**",
          embeds: [makeEmbed({
            title: `#${issueNum} — ${issue.title}`,
            url: issue.html_url,
            description: `Assigned to: ${(issue.assignees || []).map((a) => `@${a.login}`).join(", ") || "_unassigned_"}`,
            color: 0xE74C3C,
          })],
        });
      }
    }
  }

  // ========================================
  // PULL REQUEST EVENTS
  // ========================================
  if (event === "pull_request") {
    const pr = body.pull_request;
    const referencedIssues = await parseIssueRefs(pr, repo);

    // PR opened: move referenced issues to In Review
    if (body.action === "opened" || body.action === "ready_for_review") {
      for (const issueNum of referencedIssues) {
        await setStatusLabel(repo, issueNum, "status:in-review");
      }
    }

    // PR merged: keep in-review (dev closes issue manually → Done)
    if (body.action === "closed" && pr.merged) {
      const created = new Date(pr.created_at).getTime();
      const merged = new Date(pr.merged_at).getTime();
      const cycleDays = Math.max(0, (merged - created) / 86400000);
      const cycleStr = cycleDays < 1 ? `${Math.round(cycleDays * 24)}h` : `${cycleDays.toFixed(1)} days`;
      await postDiscord({
        embeds: [makeEmbed({
          title: `PR merged: #${pr.number}`,
          url: pr.html_url,
          description: `**${pr.title}**\nBy @${pr.user.login}` +
            (referencedIssues.length ? `\nLinked: ${referencedIssues.map((n) => `#${n}`).join(", ")}` : ""),
          fields: [
            { name: "Cycle time", value: cycleStr, inline: true },
            { name: "Lines", value: `+${pr.additions || 0} -${pr.deletions || 0}`, inline: true },
          ],
          color: 0x27AE60,
        })],
      });
    }
  }

  res.json({ ok: true, event, action: body.action });
}
