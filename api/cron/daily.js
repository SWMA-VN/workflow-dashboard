// Vercel Cron — runs 09:00 HKT (01:00 UTC), Mon-Fri.
// See vercel.json crons schedule.

import { getMetrics } from "../../lib/github.js";
import { aiSummarize } from "../../lib/ai.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";
import { sendEmail } from "../../lib/email.js";

export default async function handler(req, res) {
  // Vercel cron sends an Authorization header with CRON_SECRET if set; skip if not configured
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const projectName = process.env.PROJECT_NAME || "Project";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Asia/Hong_Kong" });

    const m = await getMetrics({ days: 1 });

    const prompt = `You are a project manager assistant. Write a 3-sentence executive summary of yesterday's dev activity.

Data:
- Issues opened: ${m.issues_opened.length}
- Issues closed: ${m.issues_closed.length}
- PRs opened: ${m.prs_opened.length}
- PRs merged: ${m.prs_merged.length}
- Currently in progress: ${m.in_progress.length}
- Blocked: ${m.blocked.length}
- Commits: ${m.commits.length}

Closed: ${m.issues_closed.slice(0, 5).map((i) => i.title).join("; ")}
Merged PRs: ${m.prs_merged.slice(0, 5).map((p) => p.title).join("; ")}
Blockers: ${m.blocked.slice(0, 5).map((i) => i.title).join("; ")}

Be concrete. Mention names if visible. Highlight risks if blockers > 2.`;

    const summary = await aiSummarize(prompt);

    // Discord
    await postDiscord({
      content: `**Good morning! Daily snapshot for ${projectName}.**`,
      embeds: [
        makeEmbed({
          title: `📊 Daily Report — ${today}`,
          description: summary.slice(0, 2000),
          fields: [
            { name: "✅ Closed", value: String(m.issues_closed.length), inline: true },
            { name: "🔀 Merged PRs", value: String(m.prs_merged.length), inline: true },
            { name: "⚙️ In Progress", value: String(m.in_progress.length), inline: true },
            { name: "🚨 Blockers", value: String(m.blocked.length), inline: true },
            { name: "💻 Commits", value: String(m.commits.length), inline: true },
            { name: "📥 Opened", value: String(m.issues_opened.length), inline: true },
          ],
          color: m.blocked.length >= 2 ? 0xE74C3C : 0x27AE60,
        }),
      ],
    });

    // Email
    const html = `
      <html><body style="font-family: Arial, sans-serif;">
      <h2 style="color:#1F4E79">📊 Daily Report — ${projectName}</h2>
      <p><b>${today}</b></p>
      <h3>Executive Summary</h3>
      <p style="background:#f0f4f8;padding:12px;border-left:4px solid #1F4E79">${summary}</p>
      <h3>Numbers</h3>
      <ul>
        <li>Issues closed: <b>${m.issues_closed.length}</b></li>
        <li>PRs merged: <b>${m.prs_merged.length}</b></li>
        <li>In progress: <b>${m.in_progress.length}</b></li>
        <li>Blockers: <b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></li>
        <li>Commits: <b>${m.commits.length}</b></li>
      </ul>
      <hr><p style="color:#888;font-size:12px">Auto-generated. <a href="https://${process.env.VERCEL_URL || "your-pm.vercel.app"}">Open dashboard</a></p>
      </body></html>
    `;
    await sendEmail({ subject: `📊 Daily Report — ${projectName} — ${today}`, html });

    res.json({ ok: true, summary, metrics: { closed: m.issues_closed.length, merged: m.prs_merged.length, blocked: m.blocked.length } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
