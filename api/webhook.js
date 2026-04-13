// POST /api/webhook
// GitHub webhook receiver. Triggers auto-assign on new issues.
//
// Set up in your repo: Settings → Webhooks → Add webhook
//   Payload URL: https://your-pm.vercel.app/api/webhook
//   Content type: application/json
//   Secret: <same as GITHUB_WEBHOOK_SECRET env var>
//   Events: Issues, Pull requests, Pushes

import crypto from "node:crypto";
import { assignAndAnnounce } from "../lib/assign.js";
import { postDiscord, makeEmbed } from "../lib/discord.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifySignature(payload, signature, secret) {
  if (!secret) return true; // skip verification if no secret set
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ""), Buffer.from(expected));
  } catch {
    return false;
  }
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
  console.log(`[webhook] ${event} ${body.action}`);

  // === Auto-assign on new unassigned issues ===
  if (event === "issues" && body.action === "opened" && (body.issue.assignees || []).length === 0) {
    try {
      const result = await assignAndAnnounce(body.issue);
      if (result.ok) {
        await postDiscord({
          embeds: [
            makeEmbed({
              title: `🤖 Auto-assigned #${body.issue.number}`,
              url: body.issue.html_url,
              description: `**${body.issue.title}**\nAssigned to **@${result.dev}**\n_${result.reason}_`,
              color: 0x9B59B6,
            }),
          ],
        });
      }
      return res.json({ event, action: body.action, assign: result });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: e.message });
    }
  }

  // === Notify on blockers ===
  if (event === "issues" && body.action === "labeled") {
    const label = body.label?.name?.toLowerCase() || "";
    if (label === "blocked" || label === "blocker") {
      await postDiscord({
        content: "🚨 **BLOCKER ALERT**",
        embeds: [
          makeEmbed({
            title: `#${body.issue.number} — ${body.issue.title}`,
            url: body.issue.html_url,
            description: `Assigned to: ${(body.issue.assignees || []).map((a) => `@${a.login}`).join(", ") || "_unassigned_"}`,
            color: 0xE74C3C,
          }),
        ],
      });
    }
  }

  // === Notify on PR events ===
  if (event === "pull_request") {
    if (body.action === "opened" || body.action === "ready_for_review") {
      await postDiscord({
        embeds: [
          makeEmbed({
            title: `🔀 PR opened: #${body.pull_request.number}`,
            url: body.pull_request.html_url,
            description: `**${body.pull_request.title}**\nBy @${body.pull_request.user.login}`,
            color: 0x3498DB,
          }),
        ],
      });
    } else if (body.action === "closed" && body.pull_request.merged) {
      await postDiscord({
        embeds: [
          makeEmbed({
            title: `✅ PR merged: #${body.pull_request.number}`,
            url: body.pull_request.html_url,
            description: `**${body.pull_request.title}**\nBy @${body.pull_request.user.login}`,
            color: 0x27AE60,
          }),
        ],
      });
    }
  }

  res.json({ ok: true, event, action: body.action });
}
