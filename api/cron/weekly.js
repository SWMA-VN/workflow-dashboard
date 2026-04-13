// Vercel Cron — runs 17:00 HKT Friday (09:00 UTC).

import { getMetrics } from "../../lib/github.js";
import { aiSummarize } from "../../lib/ai.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";
import { sendEmail } from "../../lib/email.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const projectName = process.env.PROJECT_NAME || "Project";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Asia/Hong_Kong" });
    const m = await getMetrics({ days: 7 });

    const velocity = m.issues_closed.length + m.prs_merged.length;

    const prompt = `You are a PM assistant. Write a weekly status update (5-7 sentences) for stakeholders.

Data this week:
- Issues opened: ${m.issues_opened.length}
- Issues closed: ${m.issues_closed.length}
- PRs merged: ${m.prs_merged.length}
- Currently in progress: ${m.in_progress.length}
- Blocked: ${m.blocked.length}
- Commits: ${m.commits.length}

Top closed: ${m.issues_closed.slice(0, 8).map((i) => i.title).join("; ")}
Top merged PRs: ${m.prs_merged.slice(0, 8).map((p) => p.title).join("; ")}
Active blockers: ${m.blocked.map((i) => i.title).join("; ")}

Activity by person: ${JSON.stringify(m.by_person)}

Cover: progress this week, what's shipping next week, top 3 risks. Be specific and quantitative.`;

    const summary = await aiSummarize(prompt, { maxTokens: 2048 });

    await postDiscord({
      content: `**📈 Weekly wrap-up for ${projectName} — week ending ${today}**`,
      embeds: [
        makeEmbed({
          title: `📈 Weekly Report — ${today}`,
          description: summary.slice(0, 2000),
          fields: [
            { name: "🚀 Velocity", value: String(velocity), inline: true },
            { name: "✅ Closed", value: String(m.issues_closed.length), inline: true },
            { name: "🔀 Merged", value: String(m.prs_merged.length), inline: true },
            { name: "⚙️ In Progress", value: String(m.in_progress.length), inline: true },
            { name: "🚨 Blockers", value: String(m.blocked.length), inline: true },
            { name: "💻 Commits", value: String(m.commits.length), inline: true },
          ],
          color: m.blocked.length >= 2 ? 0xE74C3C : 0x27AE60,
        }),
      ],
    });

    const personRows = Object.entries(m.by_person)
      .sort((a, b) => b[1].commits - a[1].commits)
      .map(([p, s]) => `<tr><td>${p}</td><td>${s.commits}</td><td>${s.prs}</td></tr>`)
      .join("");

    const html = `
      <html><body style="font-family: Arial, sans-serif;">
      <h2 style="color:#1F4E79">📈 Weekly Report — ${projectName}</h2>
      <p><b>Week ending ${today}</b></p>
      <h3>Executive Summary</h3>
      <p style="background:#f0f4f8;padding:12px;border-left:4px solid #1F4E79">${summary}</p>
      <h3>Velocity Metrics</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td><b>Velocity</b></td><td>${velocity}</td></tr>
        <tr><td>Issues closed</td><td>${m.issues_closed.length}</td></tr>
        <tr><td>PRs merged</td><td>${m.prs_merged.length}</td></tr>
        <tr><td>In progress</td><td>${m.in_progress.length}</td></tr>
        <tr><td>Blockers</td><td style="color:${m.blocked.length ? "red" : "green"}"><b>${m.blocked.length}</b></td></tr>
        <tr><td>Commits</td><td>${m.commits.length}</td></tr>
      </table>
      <h3>Team Contributions</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><th>Person</th><th>Commits</th><th>PRs</th></tr>
        ${personRows}
      </table>
      <hr><p style="color:#888;font-size:12px">Auto-generated. <a href="https://${process.env.VERCEL_URL || "your-pm.vercel.app"}">Open dashboard</a></p>
      </body></html>
    `;
    await sendEmail({ subject: `📈 Weekly Report — ${projectName} — ${today}`, html });

    res.json({ ok: true, velocity, summary });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
