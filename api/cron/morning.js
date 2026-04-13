// Vercel Cron — runs 10:30 Hanoi (UTC+7) = 03:30 UTC, Mon-Fri.
// Morning report: yesterday's wins + today's plan, from GitHub + Google Sheet.

import { getMetrics, listIssues, scope } from "../../lib/github.js";
import { fetchSheet, rowsForDate, hanoiToday, hanoiYesterday } from "../../lib/sheets.js";
import { aiSummarize } from "../../lib/ai.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";
import { sendEmail } from "../../lib/email.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const projectName = process.env.PROJECT_NAME || "Project";
    const today = hanoiToday();
    const yesterday = hanoiYesterday();
    const todayStr = today.toLocaleDateString("en-CA");
    const yesterdayStr = yesterday.toLocaleDateString("en-CA");
    const sc = scope();

    // GitHub data (1-day window for "yesterday")
    const m = await getMetrics({ days: 1 });

    // Open issues currently In Progress (today's WIP)
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const inProgress = realIssues.filter((i) => (i.assignees || []).length > 0);
    const newOpen = realIssues.filter((i) => {
      const created = new Date(i.created_at).getTime();
      return created > Date.now() - 1.5 * 86400000;
    });

    // Google Sheet — yesterday's done + today's plan
    const { rows, error: sheetError } = await fetchSheet();
    let yesterdaySheetRows = [];
    let todaySheetRows = [];
    if (rows && rows.length) {
      yesterdaySheetRows = rowsForDate(rows, yesterday);
      todaySheetRows = rowsForDate(rows, today);
    }

    // Build AI summary
    const prompt = `You are a PM assistant writing the MORNING standup briefing for ${projectName}.

It's ${todayStr} (Hanoi time).

Yesterday's GitHub activity:
- Issues closed: ${m.issues_closed.length}
- PRs merged: ${m.prs_merged.length}
- Commits: ${m.commits.length}
- Top closed: ${m.issues_closed.slice(0, 5).map((i) => i.title).join("; ")}
- Top merged PRs: ${m.prs_merged.slice(0, 5).map((p) => p.title).join("; ")}

Today's GitHub WIP:
- In Progress: ${inProgress.length} issues
- New (last 36h): ${newOpen.length} issues
- Blocked: ${m.blocked.length}

Yesterday's standup log entries:
${yesterdaySheetRows.map((r) => `- ${r.Member}: did "${r["What you have done today"] || ""}" — plans: "${r["What will you do tormorrow"] || r["What will you do tomorrow"] || ""}" — issues: "${r["Any Isues?"] || r["Any Issues?"] || ""}"`).join("\n") || "(no entries yet for yesterday)"}

Today's standup log entries:
${todaySheetRows.map((r) => `- ${r.Member}: planning "${r["What you have done today"] || r["What will you do tormorrow"] || ""}"`).join("\n") || "(team has not posted today's plan yet)"}

Write a 5-7 sentence morning briefing covering:
1. What we shipped yesterday
2. Today's focus (top 3 things)
3. Any risks or blockers visible
4. One thing to celebrate or watch
Be specific, mention names if visible. Be motivating but realistic.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    // === Discord post ===
    const sheetSection = yesterdaySheetRows.length || todaySheetRows.length
      ? "📋 Sheet log: " + (yesterdaySheetRows.length + todaySheetRows.length) + " entries"
      : "📋 Sheet log: no entries today/yesterday";

    const inProgressList = inProgress.slice(0, 8)
      .map((i) => `• [#${i.number}](${i.html_url}) ${i.title.slice(0, 60)} — ${(i.assignees || []).map((a) => `@${a.login}`).join(", ")}`)
      .join("\n") || "_nothing in progress_";

    const yesterdayList = m.prs_merged.slice(0, 5).concat(m.issues_closed.slice(0, 5))
      .map((x) => `• [#${x.number}](${x.html_url}) ${(x.title || "").slice(0, 70)}`)
      .join("\n") || "_no merges/closes yesterday_";

    const sheetTodayList = todaySheetRows.slice(0, 8)
      .map((r) => `• **${r.Member}**: ${(r["What will you do tormorrow"] || r["What will you do tomorrow"] || r["What you have done today"] || "—").slice(0, 90)}`)
      .join("\n") || "_no sheet entries for today yet_";

    await postDiscord({
      content: `🌅 **Good morning! Here's the briefing for ${projectName}** — ${todayStr} (Hanoi)`,
      embeds: [
        makeEmbed({
          title: `☕ Morning Briefing — ${todayStr}`,
          description: aiSummary.slice(0, 1800),
          color: 0xF59E0B,
          fields: [
            { name: "✅ Yesterday's GitHub wins", value: yesterdayList.slice(0, 1024), inline: false },
            { name: "🔄 In Progress today", value: inProgressList.slice(0, 1024), inline: false },
            { name: "📋 Today's plan (from sheet)", value: sheetTodayList.slice(0, 1024), inline: false },
            { name: "📊 Stats", value: `Closed: ${m.issues_closed.length} · Merged: ${m.prs_merged.length} · WIP: ${inProgress.length} · Blockers: ${m.blocked.length}`, inline: false },
          ],
        }),
      ],
    });

    // === Email ===
    const sheetTodayHtml = todaySheetRows.length
      ? `<ul>${todaySheetRows.map((r) => `<li><b>${r.Member}</b>: ${r["What will you do tormorrow"] || r["What will you do tomorrow"] || r["What you have done today"] || "—"}</li>`).join("")}</ul>`
      : "<p><em>No sheet entries for today yet.</em></p>";

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 720px;">
      <h2 style="color:#F59E0B">☕ Morning Briefing — ${projectName}</h2>
      <p><b>${todayStr} (Hanoi)</b> · scope: ${sc.label}</p>
      <h3>AI Summary</h3>
      <p style="background:#fef3c7;padding:12px;border-left:4px solid #F59E0B">${aiSummary}</p>
      <h3>📋 Today's plan (from team sheet)</h3>
      ${sheetTodayHtml}
      ${sheetError ? `<p style="color:#888"><em>Sheet error: ${sheetError}</em></p>` : ""}
      <h3>📊 GitHub stats</h3>
      <ul>
        <li>Issues closed yesterday: <b>${m.issues_closed.length}</b></li>
        <li>PRs merged yesterday: <b>${m.prs_merged.length}</b></li>
        <li>Commits yesterday: <b>${m.commits.length}</b></li>
        <li>Currently in progress: <b>${inProgress.length}</b></li>
        <li>Blockers: <b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></li>
      </ul>
      <hr><p style="color:#888;font-size:12px">Auto-generated 10:30 Hanoi · <a href="https://ethanworkflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `☕ Morning Briefing — ${projectName} — ${todayStr}`, html });

    res.json({
      ok: true,
      sheet_rows_today: todaySheetRows.length,
      sheet_rows_yesterday: yesterdaySheetRows.length,
      sheet_error: sheetError || null,
      github: { closed: m.issues_closed.length, merged: m.prs_merged.length, in_progress: inProgress.length, blocked: m.blocked.length },
      summary_excerpt: aiSummary.slice(0, 200),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
