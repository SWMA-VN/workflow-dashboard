// Vercel Cron — runs daily at 11 AM HKT (03:00 UTC).
// Scans for stale tickets (>3 days no update in same column) and pings Discord.

import { listIssues } from "../../lib/github.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const now = Date.now();

    const stale = realIssues
      .filter((i) => (now - new Date(i.updated_at).getTime()) > 3 * 86400000)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        assignees: (i.assignees || []).map((a) => a.login),
        days_stale: Math.floor((now - new Date(i.updated_at).getTime()) / 86400000),
      }))
      .sort((a, b) => b.days_stale - a.days_stale)
      .slice(0, 10);

    if (!stale.length) {
      return res.json({ ok: true, stale_count: 0, message: "No stale tickets" });
    }

    const lines = stale.map((s) => {
      const assignees = s.assignees.length ? s.assignees.map((a) => `@${a}`).join(", ") : "_unassigned_";
      return `• [#${s.number}](${s.url}) **${s.title.slice(0, 80)}** — ${assignees} — _${s.days_stale}d stale_`;
    });

    await postDiscord({
      content: `⏰ **${stale.length} stale ticket${stale.length === 1 ? "" : "s"} detected** (no update in 3+ days)`,
      embeds: [
        makeEmbed({
          title: "⏰ Stale Tickets",
          description: lines.join("\n").slice(0, 2000),
          color: 0xF59E0B,
        }),
      ],
    });

    res.json({ ok: true, stale_count: stale.length, stale });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
