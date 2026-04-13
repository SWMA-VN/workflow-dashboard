// Vercel Cron — runs 16:30 Hanoi (UTC+7) = 09:30 UTC, Mon-Fri.
// End-of-day report: what's done today + what's still in progress.

import { getMetrics, listIssues, scope } from "../../lib/github.js";
import { fetchSheet, rowsForDate, hanoiToday } from "../../lib/sheets.js";
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
    const todayStr = today.toLocaleDateString("en-CA");
    const sc = scope();

    // GitHub: today's activity (last 12h to capture today's day)
    const m = await getMetrics({ days: 1 });
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const inProgress = realIssues.filter((i) => (i.assignees || []).length > 0);
    const stale = realIssues.filter((i) =>
      (Date.now() - new Date(i.updated_at).getTime()) > 3 * 86400000
    ).map((i) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      assignees: (i.assignees || []).map((a) => a.login),
      days: Math.floor((Date.now() - new Date(i.updated_at).getTime()) / 86400000),
    }));

    // Sheet: today's entries
    const { rows, error: sheetError } = await fetchSheet();
    let todaySheetRows = [];
    if (rows && rows.length) todaySheetRows = rowsForDate(rows, today);

    const sheetDone = todaySheetRows.filter((r) => {
      const prog = parseInt((r["Progress (%)"] || "").replace("%", ""));
      return !isNaN(prog) && prog >= 100;
    });
    const sheetInProgress = todaySheetRows.filter((r) => {
      const prog = parseInt((r["Progress (%)"] || "").replace("%", ""));
      return isNaN(prog) || prog < 100;
    });
    const sheetIssues = todaySheetRows.filter((r) => (r["Any Isues?"] || r["Any Issues?"] || "").trim());

    // AI summary
    const prompt = `You are a PM assistant writing the END-OF-DAY check-in for ${projectName}.

It's ${todayStr} 16:30 Hanoi time. Day is wrapping up.

Today's GitHub activity:
- Issues closed: ${m.issues_closed.length}
- PRs merged: ${m.prs_merged.length}
- Commits: ${m.commits.length}
- Top closed: ${m.issues_closed.slice(0, 5).map((i) => i.title).join("; ")}
- Top merged PRs: ${m.prs_merged.slice(0, 5).map((p) => p.title).join("; ")}

Currently in progress: ${inProgress.length} issues
Stale (3+ days no activity): ${stale.length}
Blockers: ${m.blocked.length}

Sheet log entries posted today: ${todaySheetRows.length}
- Marked done (100%): ${sheetDone.length}
- Still in progress: ${sheetInProgress.length}
- Reporting issues: ${sheetIssues.length}

Done today (sheet):
${sheetDone.map((r) => `- ${r.Member}: ${r["What you have done today"]}`).join("\n") || "(nothing marked 100% in sheet)"}

Still in progress (sheet):
${sheetInProgress.map((r) => `- ${r.Member}: ${r["What you have done today"]} — plans tomorrow: ${r["What will you do tormorrow"] || r["What will you do tomorrow"] || ""}`).join("\n") || "(nothing logged in sheet)"}

Issues raised:
${sheetIssues.map((r) => `- ${r.Member}: ${r["Any Isues?"] || r["Any Issues?"]}`).join("\n") || "(none)"}

Write a 5-7 sentence END-OF-DAY summary covering:
1. What got shipped today (be concrete)
2. What's still cooking (rolling to tomorrow)
3. Any blockers/risks to flag for tomorrow
4. One micro-celebration if something good happened
Be specific, mention names. Honest tone — if today was light, say so.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    // Discord post
    const doneList = m.prs_merged.slice(0, 6).concat(m.issues_closed.slice(0, 6))
      .map((x) => `• [#${x.number}](${x.html_url}) ${(x.title || "").slice(0, 70)}`)
      .join("\n") || "_nothing closed/merged today_";

    const wipList = inProgress.slice(0, 8)
      .map((i) => `• [#${i.number}](${i.html_url}) ${i.title.slice(0, 60)} — ${(i.assignees || []).map((a) => `@${a.login}`).join(", ")}`)
      .join("\n") || "_no WIP_";

    const staleList = stale.slice(0, 5)
      .map((s) => `⏰ [#${s.number}](${s.url}) ${s.title.slice(0, 55)} — ${s.assignees.map((a) => `@${a}`).join(", ") || "_unassigned_"} (${s.days}d)`)
      .join("\n") || "_no stale items_";

    const sheetDoneList = sheetDone.slice(0, 8)
      .map((r) => `✅ **${r.Member}**: ${(r["What you have done today"] || "").slice(0, 90)}`)
      .join("\n") || "_no 100% items in sheet_";

    const issuesList = sheetIssues.slice(0, 5)
      .map((r) => `🚨 **${r.Member}**: ${(r["Any Isues?"] || r["Any Issues?"] || "").slice(0, 90)}`)
      .join("\n");

    const fields = [
      { name: "✅ Done today (GitHub)", value: doneList.slice(0, 1024), inline: false },
      { name: "📋 Done today (sheet, 100%)", value: sheetDoneList.slice(0, 1024), inline: false },
      { name: "🔄 Still in progress (rolling tomorrow)", value: wipList.slice(0, 1024), inline: false },
    ];
    if (stale.length) fields.push({ name: "⏰ Stale items needing attention", value: staleList.slice(0, 1024), inline: false });
    if (issuesList) fields.push({ name: "🚨 Issues raised by team", value: issuesList.slice(0, 1024), inline: false });

    await postDiscord({
      content: `🌇 **End of day check-in for ${projectName}** — ${todayStr} (Hanoi)`,
      embeds: [
        makeEmbed({
          title: `🌇 EOD Report — ${todayStr}`,
          description: aiSummary.slice(0, 1800),
          color: m.blocked.length || stale.length >= 3 ? 0xE74C3C : 0x16A085,
          fields,
        }),
      ],
    });

    // Email
    const sheetDoneHtml = sheetDone.length
      ? `<ul>${sheetDone.map((r) => `<li><b>${r.Member}</b>: ${r["What you have done today"]}</li>`).join("")}</ul>`
      : "<p><em>No items marked 100% in sheet today.</em></p>";

    const sheetWipHtml = sheetInProgress.length
      ? `<ul>${sheetInProgress.map((r) => `<li><b>${r.Member}</b>: ${r["What you have done today"]} <em>→ tomorrow: ${r["What will you do tormorrow"] || r["What will you do tomorrow"] || "—"}</em></li>`).join("")}</ul>`
      : "<p><em>No WIP items in sheet.</em></p>";

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 720px;">
      <h2 style="color:#16A085">🌇 EOD Check-in — ${projectName}</h2>
      <p><b>${todayStr} 16:30 (Hanoi)</b> · scope: ${sc.label}</p>
      <h3>AI Summary</h3>
      <p style="background:#d1fae5;padding:12px;border-left:4px solid #16A085">${aiSummary}</p>
      <h3>✅ Done today (sheet, 100%)</h3>
      ${sheetDoneHtml}
      <h3>🔄 Still in progress → tomorrow (sheet)</h3>
      ${sheetWipHtml}
      ${sheetError ? `<p style="color:#888"><em>Sheet error: ${sheetError}</em></p>` : ""}
      <h3>📊 GitHub today</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td>Closed</td><td><b>${m.issues_closed.length}</b></td></tr>
        <tr><td>PRs merged</td><td><b>${m.prs_merged.length}</b></td></tr>
        <tr><td>Commits</td><td><b>${m.commits.length}</b></td></tr>
        <tr><td>Still in progress</td><td><b>${inProgress.length}</b></td></tr>
        <tr><td>Stale (3+ days)</td><td><b>${stale.length}</b></td></tr>
        <tr><td>Blockers</td><td><b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></td></tr>
      </table>
      <hr><p style="color:#888;font-size:12px">Auto-generated 16:30 Hanoi · <a href="https://ethanworkflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `🌇 EOD Report — ${projectName} — ${todayStr}`, html });

    res.json({
      ok: true,
      sheet_today: todaySheetRows.length,
      sheet_done: sheetDone.length,
      sheet_wip: sheetInProgress.length,
      sheet_issues: sheetIssues.length,
      sheet_error: sheetError || null,
      github: {
        closed: m.issues_closed.length,
        merged: m.prs_merged.length,
        in_progress: inProgress.length,
        stale: stale.length,
        blocked: m.blocked.length,
      },
      summary_excerpt: aiSummary.slice(0, 200),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
