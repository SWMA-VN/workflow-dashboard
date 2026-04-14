// POST /api/webhook
// GitHub webhook receiver. Handles:
//   1. Auto-assign on new issues
//   2. Auto-status tracking (labels) based on dev actions:
//      - assigned → status:in-progress
//      - PR opened referencing issue → status:in-review
//      - PR merged referencing issue → status:testing
//      - issue closed → Done (all status labels removed)
//      - label "blocked" → Blocked
//   3. Discord notifications for key events
//
// Required webhook events: Issues, Pull requests, Pushes

import crypto from "node:crypto";
import { assignAndAnnounce } from "../lib/assign.js";
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

// GitHub API helpers
function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function setStatusLabel(repo, issueNumber, newStatus) {
  // Remove all existing status labels, then add the new one
  try {
    // Get current labels
    const r = await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels`, { headers: ghHeaders() });
    if (!r.ok) return;
    const labels = await r.json();
    const currentStatus = labels.filter((l) => STATUS_LABELS.includes(l.name));

    // Remove old status labels
    for (const old of currentStatus) {
      if (old.name !== newStatus) {
        await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(old.name)}`, {
          method: "DELETE",
          headers: ghHeaders(),
        });
      }
    }

    // Add new status label (if not already present)
    if (newStatus && !currentStatus.some((l) => l.name === newStatus)) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels`, {
        method: "POST",
        headers: ghHeaders(),
        body: JSON.stringify({ labels: [newStatus] }),
      });
    }
  } catch (e) {
    console.error(`[webhook] setStatusLabel error for #${issueNumber}:`, e.message);
  }
}

async function clearStatusLabels(repo, issueNumber) {
  try {
    for (const label of STATUS_LABELS) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
        headers: ghHeaders(),
      }).catch(() => {});
    }
  } catch (e) {
    console.error(`[webhook] clearStatusLabels error:`, e.message);
  }
}

// Parse issue numbers from PR — checks body, title, AND branch name.
// Branch name like "35-backend-api" or "feature/42-payment" → extracts issue number.
// This means devs don't need to write "Closes #42" — just naming the branch is enough.
function parseIssueRefs(pr) {
  const text = `${pr.title || ""} ${pr.body || ""}`;
  const matches = [...text.matchAll(/(?:closes?|fixes?|resolves?|refs?)?\s*#(\d+)/gi)];
  const nums = new Set(matches.map((m) => parseInt(m[1])));

  // Also extract from branch name: "35-backend-api", "feature/42-payment", "TC-042-fix"
  const branch = pr.head?.ref || "";
  const branchMatch = branch.match(/(?:^|[\/\-_])(\d+)(?:[\/\-_]|$)/);
  if (branchMatch) nums.add(parseInt(branchMatch[1]));

  // Filter out the PR's own number
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
  console.log(`[webhook] ${event} ${body.action} repo:${repo}`);

  // ========================================
  // ISSUES EVENTS
  // ========================================
  if (event === "issues") {
    const issue = body.issue;
    const issueNum = issue.number;

    // --- New issue: auto-assign ---
    if (body.action === "opened" && (issue.assignees || []).length === 0) {
      try {
        const result = await assignAndAnnounce(issue);
        if (result.ok) {
          await postDiscord({
            embeds: [makeEmbed({
              title: `Auto-assigned #${issueNum} to @${result.dev}`,
              url: issue.html_url,
              description: `**${issue.title}**\n_${result.reason}_`,
              color: 0x9B59B6,
            })],
          });
        }
      } catch (e) {
        console.error(e);
      }
    }

    // --- Assigned: move to In Progress ---
    if (body.action === "assigned") {
      await setStatusLabel(repo, issueNum, "status:in-progress");
    }

    // --- Closed: move to Done (clear all status labels) ---
    if (body.action === "closed") {
      await clearStatusLabels(repo, issueNum);
      const created = new Date(issue.created_at).getTime();
      const closed = new Date(issue.closed_at).getTime();
      const liveDays = Math.max(0, (closed - created) / 86400000);
      const assignees = (issue.assignees || []).map((a) => `@${a.login}`).join(", ") || "_unassigned_";
      await postDiscord({
        embeds: [makeEmbed({
          title: `Issue closed: #${issueNum}`,
          url: issue.html_url,
          description: `**${issue.title}**\nClosed by ${assignees} after ${liveDays.toFixed(1)} days`,
          color: 0x16A085,
        })],
      });
    }

    // --- Blocked label added ---
    if (body.action === "labeled") {
      const label = body.label?.name?.toLowerCase() || "";
      if (label === "blocked" || label === "blocker") {
        await postDiscord({
          content: "**BLOCKER ALERT**",
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
    const referencedIssues = parseIssueRefs(pr);

    // --- PR opened / ready for review: move referenced issues to In Review ---
    if (body.action === "opened" || body.action === "ready_for_review") {
      for (const issueNum of referencedIssues) {
        await setStatusLabel(repo, issueNum, "status:in-review");
      }
      await postDiscord({
        embeds: [makeEmbed({
          title: `PR opened: #${pr.number}`,
          url: pr.html_url,
          description: `**${pr.title}**\nBy @${pr.user.login}` +
            (referencedIssues.length ? `\nLinked issues: ${referencedIssues.map((n) => `#${n}`).join(", ")} → moved to **In Review**` : ""),
          color: 0x3498DB,
        })],
      });
    }

    // --- PR merged: move referenced issues to Testing ---
    if (body.action === "closed" && pr.merged) {
      for (const issueNum of referencedIssues) {
        await setStatusLabel(repo, issueNum, "status:testing");
      }
      const created = new Date(pr.created_at).getTime();
      const merged = new Date(pr.merged_at).getTime();
      const cycleDays = Math.max(0, (merged - created) / 86400000);
      const cycleStr = cycleDays < 1 ? `${Math.round(cycleDays * 24)}h` : `${cycleDays.toFixed(1)} days`;
      const speed = cycleDays < 1 ? "Fast" : cycleDays < 3 ? "Healthy" : cycleDays < 7 ? "Average" : "Slow";
      await postDiscord({
        embeds: [makeEmbed({
          title: `PR merged: #${pr.number}`,
          url: pr.html_url,
          description: `**${pr.title}**\nBy @${pr.user.login}` +
            (referencedIssues.length ? `\nLinked issues: ${referencedIssues.map((n) => `#${n}`).join(", ")} → moved to **Testing**` : ""),
          fields: [
            { name: "Cycle time", value: cycleStr, inline: true },
            { name: "Speed", value: speed, inline: true },
            { name: "Lines", value: `+${pr.additions || 0} -${pr.deletions || 0}`, inline: true },
          ],
          color: 0x27AE60,
        })],
      });
    }

    // --- PR converted to draft: move back to In Progress ---
    if (body.action === "converted_to_draft") {
      for (const issueNum of referencedIssues) {
        await setStatusLabel(repo, issueNum, "status:in-progress");
      }
    }
  }

  res.json({ ok: true, event, action: body.action });
}
