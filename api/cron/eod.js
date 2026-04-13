// Vercel Cron — runs 16:15 Hanoi (UTC+7) = 09:15 UTC, Mon-Fri.
// EOD: per-member done + in-progress from the team standup sheet + GitHub stats.
// Manual trigger override: ?date=M/D/YYYY (e.g. ?date=4/10/2026 to rerun yesterday).

import { getMetrics, listIssues, scope } from "../../lib/github.js";
import { getDayActivity, hanoiToday, parseSheetDate, formatSheetDate } from "../../lib/sheets.js";
import { aiSummarize } from "../../lib/ai.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";
import { sendEmail } from "../../lib/email.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const projectName = process.env.PROJECT_NAME || "Project";
    const sc = scope();

    // Allow ?date= to rerun for a past date
    let target = req.query?.date ? parseSheetDate(req.query.date) : hanoiToday();
    if (!target) target = hanoiToday();
    const dateStr = formatSheetDate(target);
    const isoStr = target.toISOString().slice(0, 10);

    // === Sheet: today's afternoon section ===
    const { day, error: sheetError } = await getDayActivity(target);
    const afternoon = (day && day.afternoon) || {};
    const morning = (day && day.morning) || {};
    const allMembers = Array.from(new Set([...Object.keys(afternoon), ...Object.keys(morning)]));

    // === GitHub: today's activity ===
    const m = await getMetrics({ days: 1 });
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const inProgressGh = realIssues.filter((i) => (i.assignees || []).length > 0);
    const stale = realIssues
      .filter((i) => (Date.now() - new Date(i.updated_at).getTime()) > 3 * 86400000)
      .map((i) => ({
        number: i.number, title: i.title, url: i.html_url,
        assignees: (i.assignees || []).map((a) => a.login),
        days: Math.floor((Date.now() - new Date(i.updated_at).getTime()) / 86400000),
      }));

    // Build per-member lines + delivery status
    const memberLines = allMembers.map((mb) => {
      const aft = afternoon[mb] || {};
      const morn = morning[mb] || {};
      const done = aft.done || "—";
      const inProg = aft.inProgress || "—";
      const issues = aft.issues || morn.issues || "";

      // Delivery status per member (deterministic, no AI needed)
      let status, statusEmoji;
      if (done !== "—" && inProg === "—") { status = "shipped, capacity free"; statusEmoji = "🟢"; }
      else if (done !== "—" && inProg !== "—") { status = "shipped + carrying over"; statusEmoji = "🔵"; }
      else if (done === "—" && inProg !== "—") { status = "still working"; statusEmoji = "🟡"; }
      else { status = "no log"; statusEmoji = "⚪"; }
      if (issues) statusEmoji = "🚨";

      return { member: mb, done, inProgress: inProg, issues, status, statusEmoji };
    });

    const doneCount = memberLines.filter((l) => l.done && l.done !== "—").length;
    const wipCount = memberLines.filter((l) => l.inProgress && l.inProgress !== "—").length;
    const issuesCount = memberLines.filter((l) => l.issues).length;

    // Team focus snapshot (deterministic, no AI)
    const focusBlock = memberLines.map((l) => {
      const focus = pickFocus(l.done, l.inProgress);
      return `${l.statusEmoji} **${l.member}** — _${l.status}_\n   🎯 Focus: ${focus}`;
    }).join("\n\n");

    // ===== Build Discord post =====
    const sheetDoneText = memberLines
      .filter((l) => l.done && l.done !== "—")
      .map((l) => `**${l.member}** ✅\n${truncate(l.done, 280)}`)
      .join("\n\n") || "_no team done entries in sheet for this day_";

    const sheetWipText = memberLines
      .filter((l) => l.inProgress && l.inProgress !== "—")
      .map((l) => `**${l.member}** 🔄\n${truncate(l.inProgress, 280)}`)
      .join("\n\n") || "_nothing in-progress in sheet_";

    const issuesText = memberLines
      .filter((l) => l.issues)
      .map((l) => `🚨 **${l.member}**: ${truncate(l.issues, 200)}`)
      .join("\n");

    const ghDoneList = m.prs_merged.slice(0, 5).concat(m.issues_closed.slice(0, 5))
      .map((x) => `• [#${x.number}](${x.html_url}) ${truncate(x.title || "", 70)}`)
      .join("\n") || "_nothing closed/merged on this date in GitHub_";

    const ghWipList = inProgressGh.slice(0, 8)
      .map((i) => `• [#${i.number}](${i.html_url}) ${truncate(i.title, 60)} — ${(i.assignees || []).map((a) => `@${a.login}`).join(", ")}`)
      .join("\n") || "_no GitHub WIP_";

    const staleList = stale.slice(0, 5)
      .map((s) => `⏰ [#${s.number}](${s.url}) ${truncate(s.title, 55)} — ${s.assignees.map((a) => `@${a}`).join(", ") || "_unassigned_"} (${s.days}d)`)
      .join("\n");

    // === AI summary ===
    const prompt = `You are a PM assistant writing the END-OF-DAY check-in for ${projectName} on ${dateStr} (Hanoi).

TEAM SHEET — ${allMembers.length} members logged today:

DONE today (per member):
${memberLines.filter((l) => l.done && l.done !== "—").map((l) => `${l.member}: ${l.done}`).join("\n") || "(no team done entries)"}

IN PROGRESS (rolling tomorrow):
${memberLines.filter((l) => l.inProgress && l.inProgress !== "—").map((l) => `${l.member}: ${l.inProgress}`).join("\n") || "(none)"}

ISSUES RAISED:
${memberLines.filter((l) => l.issues).map((l) => `${l.member}: ${l.issues}`).join("\n") || "(none)"}

GITHUB on this date:
- Issues closed: ${m.issues_closed.length}
- PRs merged: ${m.prs_merged.length}
- Commits: ${m.commits.length}
- Currently in progress: ${inProgressGh.length}
- Stale (3+ days): ${stale.length}
- Blockers: ${m.blocked.length}

Write 5-7 sentences:
1. What got shipped today (be SPECIFIC, mention member names + features)
2. What's rolling to tomorrow (key WIP)
3. Any risks or blockers to flag
4. One micro-celebration
Honest tone — if light, say so.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    const fields = [
      { name: `🎯 DELIVERY FOCUS — per member`, value: truncate(focusBlock, 1024), inline: false },
      { name: `✅ Sheet — DONE today (${doneCount} members)`, value: truncate(sheetDoneText, 1024), inline: false },
      { name: `🔄 Sheet — IN PROGRESS (rolling tomorrow, ${wipCount} members)`, value: truncate(sheetWipText, 1024), inline: false },
    ];
    if (issuesText) fields.push({ name: `🚨 Issues raised (${issuesCount})`, value: truncate(issuesText, 1024), inline: false });
    fields.push({ name: "🐙 GitHub — closed/merged on this date", value: truncate(ghDoneList, 1024), inline: false });
    fields.push({ name: `🐙 GitHub — currently in-progress (${inProgressGh.length})`, value: truncate(ghWipList, 1024), inline: false });
    if (staleList) fields.push({ name: `⏰ Stale items (${stale.length})`, value: truncate(staleList, 1024), inline: false });

    await postDiscord({
      content: `🌇 **End of day check-in — ${projectName}** — ${dateStr} (Hanoi)`,
      embeds: [
        makeEmbed({
          title: `🌇 EOD Report — ${dateStr}`,
          description: truncate(aiSummary, 1800),
          color: m.blocked.length || stale.length >= 3 || issuesCount ? 0xE74C3C : 0x16A085,
          fields,
        }),
      ],
    });

    // ===== Email =====
    const sheetDoneHtml = memberLines.filter((l) => l.done && l.done !== "—").length
      ? `<ul>${memberLines.filter((l) => l.done && l.done !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.done)}</pre></li>`).join("")}</ul>`
      : "<p><em>No DONE entries from team in sheet for this date.</em></p>";

    const sheetWipHtml = memberLines.filter((l) => l.inProgress && l.inProgress !== "—").length
      ? `<ul>${memberLines.filter((l) => l.inProgress && l.inProgress !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.inProgress)}</pre></li>`).join("")}</ul>`
      : "<p><em>No IN-PROGRESS entries from team for this date.</em></p>";

    const issuesHtml = memberLines.filter((l) => l.issues).length
      ? `<ul>${memberLines.filter((l) => l.issues).map((l) => `<li><b>${esc(l.member)}</b>: ${esc(l.issues)}</li>`).join("")}</ul>`
      : "";

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 760px;">
      <h2 style="color:#16A085">🌇 EOD Check-in — ${esc(projectName)}</h2>
      <p><b>${dateStr} 16:15 (Hanoi)</b> · scope: ${esc(sc.label)}</p>
      <h3>AI Summary</h3>
      <p style="background:#d1fae5;padding:12px;border-left:4px solid #16A085;white-space:pre-wrap">${esc(aiSummary)}</p>

      <h3>🎯 Delivery focus per member</h3>
      <ul>${memberLines.map((l) => `<li>${l.statusEmoji} <b>${esc(l.member)}</b> — <em>${esc(l.status)}</em><br>🎯 ${esc(pickFocus(l.done, l.inProgress))}</li>`).join("")}</ul>

      <h3>✅ Done today (per team member)</h3>
      ${sheetDoneHtml}

      <h3>🔄 In Progress → tomorrow</h3>
      ${sheetWipHtml}

      ${issuesHtml ? `<h3>🚨 Issues raised</h3>${issuesHtml}` : ""}

      ${sheetError ? `<p style="color:#888"><em>Sheet error: ${esc(sheetError)}</em></p>` : ""}

      <h3>🐙 GitHub on ${isoStr}</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td>Issues closed</td><td><b>${m.issues_closed.length}</b></td></tr>
        <tr><td>PRs merged</td><td><b>${m.prs_merged.length}</b></td></tr>
        <tr><td>Commits</td><td><b>${m.commits.length}</b></td></tr>
        <tr><td>Currently in progress</td><td><b>${inProgressGh.length}</b></td></tr>
        <tr><td>Stale (3+ days)</td><td><b>${stale.length}</b></td></tr>
        <tr><td>Blockers</td><td><b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></td></tr>
      </table>

      <hr><p style="color:#888;font-size:12px">Auto-generated · <a href="https://ethanworkflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `🌇 EOD — ${projectName} — ${dateStr}`, html });

    res.json({
      ok: true,
      target_date: dateStr,
      members_in_sheet: allMembers.length,
      sheet_done: doneCount,
      sheet_wip: wipCount,
      sheet_issues: issuesCount,
      sheet_error: sheetError || null,
      github: {
        closed: m.issues_closed.length,
        merged: m.prs_merged.length,
        commits: m.commits.length,
        in_progress: inProgressGh.length,
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

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Distill the most concrete focus theme from a member's done + in-progress text.
// Returns short phrase (~40-80 chars) PMs can scan in 1 second.
function pickFocus(done, inProgress) {
  const text = [
    done && done !== "—" ? done : "",
    inProgress && inProgress !== "—" ? inProgress : "",
  ].join(" \n ").toLowerCase();
  if (!text.trim()) return "no entry today";

  // Keyword-driven focus categorization
  const themes = [
    { kw: ["medusa", "bydesign"], label: "Medusa / ByDesign integration" },
    { kw: ["payment", "hitpay", "wechat", "fps", "checkout"], label: "Payment flow" },
    { kw: ["enrollment", "enrollmentform"], label: "Enrollment form" },
    { kw: ["cart"], label: "Cart refactor" },
    { kw: ["e2e", "test", "luckywheel", "qa"], label: "E2E / QA testing" },
    { kw: ["mobile", "ios", "android", "watch face", "psaim", "sdk"], label: "Mobile SDK / app" },
    { kw: ["bundle-report"], label: "Bundle-report fix" },
    { kw: ["staging", "deploy", "pipeline", "ci/cd", "configure workflow"], label: "Deploy / DevOps" },
    { kw: ["ai", "deals", "language", "translate"], label: "AI / multi-language" },
    { kw: ["contact", "import"], label: "Contacts import flow" },
  ];

  const hit = themes.find((t) => t.kw.some((k) => text.includes(k)));
  if (hit) {
    // Append a short snippet showing the actual task title
    const firstLine = (inProgress !== "—" ? inProgress : done).split(/\n|\.|;/)[0].trim();
    return `${hit.label} · ${truncate(firstLine, 60)}`;
  }
  // Fallback: first 60 chars of in-progress (or done)
  const fallback = (inProgress !== "—" ? inProgress : done).split(/\n|\.|;/)[0].trim();
  return truncate(fallback, 80);
}
