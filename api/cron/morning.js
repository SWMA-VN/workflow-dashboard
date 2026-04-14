// Vercel Cron — runs 10:15 Hanoi (UTC+7) = 03:15 UTC, Mon-Fri.
// Morning briefing: per-member yesterday recap (sheet morning section)
//   + today's plan + GitHub WIP context.
// Yesterday = last working day (Mon's yesterday = Friday).
// Manual override: ?date=M/D/YYYY

import { getMetrics, listIssues, scope } from "../../lib/github.js";
import {
  getDayActivity, hanoiToday, lastWorkdayBefore, parseSheetDate, formatSheetDate,
} from "../../lib/sheets.js";
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

    let today = req.query?.date ? parseSheetDate(req.query.date) : hanoiToday();
    if (!today) today = hanoiToday();
    const yesterday = lastWorkdayBefore(today);
    const todayStr = formatSheetDate(today);
    const yesterdayStr = formatSheetDate(yesterday);

    // Sheet — yesterday's afternoon (what they finished) + today's morning (what they plan)
    const { day: yDay, error: yErr } = await getDayActivity(yesterday);
    const { day: tDay, error: tErr } = await getDayActivity(today);
    const sheetError = yErr || tErr;

    const yAft = (yDay && yDay.afternoon) || {};
    const tMorn = (tDay && tDay.morning) || {};
    const allMembers = Array.from(new Set([
      ...Object.keys(yAft), ...Object.keys(tMorn),
    ]));

    // GitHub: 1-day window
    const m = await getMetrics({ days: 1 });
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const inProgressGh = realIssues.filter((i) => (i.assignees || []).length > 0);

    // Build per-member section + delivery focus
    const memberRows = allMembers.map((mb) => {
      const yDone = (yAft[mb] || {}).done || "—";
      const yWip = (yAft[mb] || {}).inProgress || "—";
      const tToday = (tMorn[mb] || {}).today || "—";
      const tYesterday = (tMorn[mb] || {}).yesterday || "—";

      let status, statusTag;
      if (tToday !== "—" && yDone !== "—") { status = "shipped yesterday + has plan"; statusTag = "[DONE+PLAN]"; }
      else if (tToday !== "—") { status = "fresh plan today"; statusTag = "[PLAN]"; }
      else if (yWip !== "—") { status = "carrying over"; statusTag = "[WIP]"; }
      else if (yDone !== "—") { status = "shipped, awaiting plan"; statusTag = "[DONE]"; }
      else { status = "no log"; statusTag = "[--]"; }

      return { member: mb, yesterdayDone: yDone, yesterdayWip: yWip, todayPlan: tToday, todayYesterdayRecap: tYesterday, status, statusTag };
    });

    const focusBlock = memberRows.map((l) => {
      const focus = pickFocus(l.todayPlan !== "—" ? l.todayPlan : (l.yesterdayWip !== "—" ? l.yesterdayWip : l.yesterdayDone));
      return `${l.statusTag} **${l.member}** — _${l.status}_\n> Focus: ${focus}`;
    }).join("\n\n");

    const yesterdayDoneText = memberRows
      .filter((l) => l.yesterdayDone && l.yesterdayDone !== "—")
      .map((l) => `**${l.member}**\n> ${truncate(l.yesterdayDone, 280)}`)
      .join("\n\n") || `_no DONE entries in sheet for ${yesterdayStr}_`;

    const todayPlanText = memberRows
      .filter((l) => l.todayPlan && l.todayPlan !== "—")
      .map((l) => `**${l.member}**\n> ${truncate(l.todayPlan, 280)}`)
      .join("\n\n") || `_no team plan in sheet for ${todayStr} yet_`;

    const carryOverText = memberRows
      .filter((l) => l.yesterdayWip && l.yesterdayWip !== "—")
      .map((l) => `**${l.member}**\n> ${truncate(l.yesterdayWip, 240)}`)
      .join("\n\n");

    // AI brief
    const prompt = `You are a PM assistant writing the MORNING briefing for ${projectName}.
Today is ${todayStr} (Hanoi). "Yesterday" workday = ${yesterdayStr}.

WHAT THE TEAM SAID YESTERDAY (afternoon section):
DONE:
${memberRows.filter((l) => l.yesterdayDone && l.yesterdayDone !== "—").map((l) => `${l.member}: ${l.yesterdayDone}`).join("\n") || "(none logged)"}

CARRYING OVER (in-progress yesterday → still going):
${memberRows.filter((l) => l.yesterdayWip && l.yesterdayWip !== "—").map((l) => `${l.member}: ${l.yesterdayWip}`).join("\n") || "(none)"}

WHAT THE TEAM PLANS TODAY (morning section):
${memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").map((l) => `${l.member}: ${l.todayPlan}`).join("\n") || "(no team plan posted yet)"}

GITHUB CONTEXT:
- Yesterday closed: ${m.issues_closed.length}, merged: ${m.prs_merged.length}, commits: ${m.commits.length}
- Currently in-progress: ${inProgressGh.length}, blockers: ${m.blocked.length}

Write a 5-7 sentence morning briefing covering:
1. What we shipped yesterday (be specific, mention names + features)
2. Today's focus (top 3 priorities visible)
3. Any risks or carryovers to watch
4. One motivating note
Be concrete and direct.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    // Discord
    const fields = [
      { name: `DELIVERY FOCUS — per member today`, value: truncate(focusBlock, 1024), inline: false },
      { name: `Yesterday (${yesterdayStr}) — DONE per member`, value: truncate(yesterdayDoneText, 1024), inline: false },
    ];
    if (carryOverText) fields.push({ name: `Carrying over from yesterday`, value: truncate(carryOverText, 1024), inline: false });
    fields.push({ name: `Today (${todayStr}) — PLAN per member`, value: truncate(todayPlanText, 1024), inline: false });
    fields.push({
      name: "GitHub stats",
      value: `Yesterday: closed ${m.issues_closed.length}, merged ${m.prs_merged.length}, commits ${m.commits.length}\nNow: in-progress ${inProgressGh.length}, blockers ${m.blocked.length}`,
      inline: false,
    });

    await postDiscord({
      content: `**Morning Briefing — ${projectName}** — ${todayStr} (Hanoi)`,
      embeds: [
        makeEmbed({
          title: `Morning Briefing — ${todayStr}`,
          description: truncate(aiSummary, 1800),
          color: 0xF59E0B,
          fields,
        }),
      ],
    });

    // Email
    const yDoneHtml = memberRows.filter((l) => l.yesterdayDone && l.yesterdayDone !== "—").length
      ? `<ul>${memberRows.filter((l) => l.yesterdayDone && l.yesterdayDone !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.yesterdayDone)}</pre></li>`).join("")}</ul>`
      : `<p><em>No DONE entries in sheet for ${yesterdayStr}.</em></p>`;
    const tPlanHtml = memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").length
      ? `<ul>${memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.todayPlan)}</pre></li>`).join("")}</ul>`
      : `<p><em>No team plans for ${todayStr} yet.</em></p>`;

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 760px;">
      <h2 style="color:#F59E0B">Morning Briefing — ${esc(projectName)}</h2>
      <p><b>${todayStr} 10:15 (Hanoi)</b> · yesterday workday: ${yesterdayStr} · scope: ${esc(sc.label)}</p>
      <h3>AI Summary</h3>
      <p style="background:#fef3c7;padding:12px;border-left:4px solid #F59E0B;white-space:pre-wrap">${esc(aiSummary)}</p>
      <h3>🎯 Delivery focus per member today</h3>
      <ul>${memberRows.map((l) => `<li><b>[${esc(l.statusTag.replace(/[\[\]]/g, ''))}] ${esc(l.member)}</b> — <em>${esc(l.status)}</em><br>Focus: ${esc(pickFocus(l.todayPlan !== "—" ? l.todayPlan : (l.yesterdayWip !== "—" ? l.yesterdayWip : l.yesterdayDone)))}</li>`).join("")}</ul>
      <h3>✅ Yesterday — DONE</h3>
      ${yDoneHtml}
      <h3>➡️ Today — PLAN</h3>
      ${tPlanHtml}
      ${sheetError ? `<p style="color:#888"><em>Sheet error: ${esc(sheetError)}</em></p>` : ""}
      <h3>🐙 GitHub</h3>
      <ul>
        <li>Yesterday closed: <b>${m.issues_closed.length}</b></li>
        <li>Yesterday merged: <b>${m.prs_merged.length}</b></li>
        <li>Yesterday commits: <b>${m.commits.length}</b></li>
        <li>Now in-progress: <b>${inProgressGh.length}</b></li>
        <li>Blockers: <b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></li>
      </ul>
      <hr><p style="color:#888;font-size:12px">Auto-generated · <a href="https://ethanworkflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `Morning Briefing — ${projectName} — ${todayStr}`, html });

    res.json({
      ok: true,
      today: todayStr,
      yesterday_workday: yesterdayStr,
      members_logged: allMembers.length,
      yesterday_done_count: memberRows.filter((l) => l.yesterdayDone && l.yesterdayDone !== "—").length,
      today_plan_count: memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").length,
      carryover_count: memberRows.filter((l) => l.yesterdayWip && l.yesterdayWip !== "—").length,
      sheet_error: sheetError || null,
      github: { closed: m.issues_closed.length, merged: m.prs_merged.length, commits: m.commits.length, in_progress: inProgressGh.length, blockers: m.blocked.length },
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

function pickFocus(text, _ignored) {
  const t = (text || "").toLowerCase();
  if (!t.trim() || t === "—") return "no entry yet";
  const themes = [
    { kw: ["medusa", "bydesign"], label: "Medusa / ByDesign" },
    { kw: ["payment", "hitpay", "wechat", "fps", "checkout"], label: "Payment flow" },
    { kw: ["enrollment", "enrollmentform"], label: "Enrollment form" },
    { kw: ["cart"], label: "Cart refactor" },
    { kw: ["e2e", "test", "luckywheel", "qa"], label: "E2E / QA" },
    { kw: ["mobile", "ios", "android", "watch face", "psaim", "sdk"], label: "Mobile SDK / app" },
    { kw: ["bundle-report"], label: "Bundle-report" },
    { kw: ["staging", "deploy", "pipeline", "ci/cd", "configure workflow"], label: "Deploy / DevOps" },
    { kw: ["ai", "deals", "language", "translate"], label: "AI / multi-language" },
    { kw: ["contact", "import"], label: "Contacts" },
  ];
  const hit = themes.find((th) => th.kw.some((k) => t.includes(k)));
  const firstLine = (text || "").split(/\n|\.|;/)[0].trim();
  return hit ? `${hit.label} · ${truncate(firstLine, 60)}` : truncate(firstLine, 80);
}
