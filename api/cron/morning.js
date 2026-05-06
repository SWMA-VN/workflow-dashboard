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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
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

    // Config: team mapping + excluded users (clients)
    const memberMap = (() => {
      try { return JSON.parse(process.env.MEMBER_MAP || "{}"); }
      catch { return {}; }
    })();
    const defaultMap = {
      "Duong N.": "sexybells", "Huy Huynh": "huynhtuanhuy", "Nathan C.": "khanwilson",
      "Hai L.": "hailh14", "CuongNQ": "cuonghanc",
    };
    const finalMap = Object.keys(memberMap).length ? memberMap : defaultMap;
    const excludedUsers = (process.env.EXCLUDED_USERS || "vamadeus").split(",").map((s) => s.trim().toLowerCase());
    const isExcluded = (login) => login && excludedUsers.includes(login.toLowerCase());

    // Sheet
    const { day: yDay, error: yErr } = await getDayActivity(yesterday);
    const { day: tDay, error: tErr } = await getDayActivity(today);
    const sheetError = yErr || tErr;
    const yAft = (yDay && yDay.afternoon) || {};
    const tMorn = (tDay && tDay.morning) || {};

    // GitHub yesterday activity (team only)
    const m = await getMetrics({ days: 1 });
    const teamMergedPrs = m.prs_merged.filter((p) => !isExcluded(p.user?.login));
    const teamCommits = m.commits.filter((c) => !isExcluded(c.author?.login || c.commit?.author?.name));
    const teamIssuesClosed = m.issues_closed.filter((i) => !(i.assignees || []).every((a) => isExcluded(a.login)));

    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const inProgressGh = realIssues.filter((i) => (i.assignees || []).length > 0);

    // Per-user GitHub activity (yesterday)
    const ghByUser = {};
    const ensure = (l) => { if (!ghByUser[l]) ghByUser[l] = { merged: [], commits: 0, closed: [] }; };
    for (const p of teamMergedPrs) if (p.user?.login) { ensure(p.user.login); ghByUser[p.user.login].merged.push(p); }
    for (const c of teamCommits) {
      const l = c.author?.login || c.commit?.author?.name;
      if (l) { ensure(l); ghByUser[l].commits++; }
    }
    for (const i of teamIssuesClosed) for (const a of (i.assignees || [])) { if (a.login) { ensure(a.login); ghByUser[a.login].closed.push(i); } }

    // Per-user open assigned (for today plan fallback)
    const openByUser = {};
    for (const i of realIssues) for (const a of (i.assignees || [])) {
      if (isExcluded(a.login)) continue;
      if (!openByUser[a.login]) openByUser[a.login] = [];
      openByUser[a.login].push(i);
    }

    // Build per-member from TEAM (not sheet) — always meaningful
    const memberRows = Object.keys(finalMap).map((mb) => {
      const ghUser = finalMap[mb];
      const yDoneSheet = (yAft[mb] || {}).done || "";
      const yWipSheet = (yAft[mb] || {}).inProgress || "";
      const tTodaySheet = (tMorn[mb] || {}).today || "";
      const ghAct = ghByUser[ghUser] || { merged: [], commits: 0, closed: [] };
      const ghOpen = openByUser[ghUser] || [];

      // Yesterday DONE: sheet OR GitHub activity yesterday
      let yDone = yDoneSheet;
      if (!yDone || yDone === "—") {
        const parts = [];
        if (ghAct.merged.length) parts.push(...ghAct.merged.slice(0, 3).map((p) => `Merged #${p.number}: ${p.title}`));
        if (ghAct.closed.length) parts.push(...ghAct.closed.slice(0, 2).map((i) => `Closed #${i.number}: ${i.title}`));
        if (!parts.length && ghAct.commits > 0) parts.push(`${ghAct.commits} commits`);
        yDone = parts.join("\n") || "—";
      }

      // Yesterday WIP
      let yWip = yWipSheet || "—";

      // Today PLAN: sheet OR currently assigned open issues
      let tToday = tTodaySheet;
      if (!tToday || tToday === "—") {
        if (ghOpen.length) tToday = ghOpen.slice(0, 3).map((i) => `#${i.number}: ${i.title}`).join("\n");
        else tToday = "—";
      }

      const hasYDone = yDone && yDone !== "—";
      const hasYWip = yWip && yWip !== "—";
      const hasTPlan = tToday && tToday !== "—";

      let status, statusTag;
      if (hasTPlan && hasYDone) { status = "shipped yesterday + has plan"; statusTag = "[DONE+PLAN]"; }
      else if (hasTPlan) { status = "fresh plan today"; statusTag = "[PLAN]"; }
      else if (hasYWip) { status = "carrying over"; statusTag = "[WIP]"; }
      else if (hasYDone) { status = "shipped, awaiting plan"; statusTag = "[DONE]"; }
      else if (ghAct.commits > 0) { status = `active (${ghAct.commits} commits yesterday)`; statusTag = "[ACTIVE]"; }
      else { status = "quiet"; statusTag = "[QUIET]"; }

      return { member: mb, yesterdayDone: yDone, yesterdayWip: yWip, todayPlan: tToday, todayYesterdayRecap: (tMorn[mb] || {}).yesterday || "—", status, statusTag, ghCommits: ghAct.commits };
    });

    // Compact: one line per member — skip quiet members entirely
    const activeRows = memberRows.filter((l) => l.statusTag !== "[QUIET]");
    const focusBlock = activeRows.map((l) => {
      const y = l.yesterdayDone && l.yesterdayDone !== "—" ? truncate(l.yesterdayDone.split("\n")[0], 45) : "";
      const t = l.todayPlan && l.todayPlan !== "—" ? truncate(l.todayPlan.split("\n")[0], 45) : "";
      const summary = [y, t].filter(Boolean).join(" → ");
      return `${l.statusTag} **${l.member}** ${summary}`;
    }).join("\n");

    const yesterdayDoneBlock = memberRows
      .filter((l) => l.yesterdayDone && l.yesterdayDone !== "—")
      .map((l) => `**${l.member}**: ${truncate(l.yesterdayDone.replace(/\n/g, ", "), 150)}`)
      .join("\n");

    const todayPlanBlock = memberRows
      .filter((l) => l.todayPlan && l.todayPlan !== "—")
      .map((l) => `**${l.member}**: ${truncate(l.todayPlan.replace(/\n/g, ", "), 150)}`)
      .join("\n");

    // AI brief — always analyzes GitHub activity if sheet is empty
    const prompt = `You are a PM assistant writing the MORNING briefing for ${projectName}.
Today is ${todayStr} (Hanoi). "Yesterday" workday = ${yesterdayStr}.

PER-MEMBER STATE (combined sheet + GitHub activity):
${memberRows.map((l) => `  ${l.member} [${l.statusTag}] ${l.status}: yesterdayDone="${l.yesterdayDone}", yesterdayWip="${l.yesterdayWip}", todayPlan="${l.todayPlan}", commits=${l.ghCommits}`).join("\n")}

TEAM-ONLY GITHUB ACTIVITY yesterday (excludes client users):
- PRs merged: ${teamMergedPrs.length} — titles: ${teamMergedPrs.slice(0, 8).map((p) => p.title).join(" | ")}
- Issues closed: ${teamIssuesClosed.length}
- Commits total: ${teamCommits.length}
- Currently in-progress: ${inProgressGh.length}
- Blockers: ${m.blocked.length}

Write EXACTLY 3 short sentences, max 40 words total:
1. What shipped yesterday (names + features)
2. Today's top priorities
3. One risk if any
No filler. No "stale items". No "no data". Names + features only.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    // Morning format: AI (3 lines) + focus + yesterday + today. Nothing else.
    const fields = [
      { name: `Focus (${memberRows.length})`, value: truncate(focusBlock, 1024), inline: false },
    ];
    if (yesterdayDoneBlock) fields.push({ name: `Yesterday (${yesterdayStr})`, value: truncate(yesterdayDoneBlock, 1024), inline: false });
    if (todayPlanBlock) fields.push({ name: `Today (${todayStr})`, value: truncate(todayPlanBlock, 1024), inline: false });

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
      : "";
    const tPlanHtml = memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").length
      ? `<ul>${memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.todayPlan)}</pre></li>`).join("")}</ul>`
      : `<p><em>No team plans for ${todayStr} yet.</em></p>`;

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 760px;">
      <h2 style="color:#F59E0B">Morning Briefing — ${esc(projectName)}</h2>
      <p><b>${todayStr} 10:15 (Hanoi)</b> · yesterday workday: ${yesterdayStr} · scope: ${esc(sc.label)}</p>
      <h3>AI Summary</h3>
      <p style="background:#fef3c7;padding:12px;border-left:4px solid #F59E0B;white-space:pre-wrap">${esc(aiSummary)}</p>
      <h3>Team Status</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px">
        <tr style="background:#f0f4f8"><th>Member</th><th>Status</th><th>Yesterday</th><th>Today</th></tr>
        ${memberRows.map((l) => `<tr>
          <td><b>${esc(l.member)}</b></td>
          <td>${esc(l.statusTag)}</td>
          <td>${l.yesterdayDone !== "—" ? esc(l.yesterdayDone).slice(0, 120) : "<em>—</em>"}</td>
          <td>${l.todayPlan !== "—" ? esc(l.todayPlan).slice(0, 120) : "<em>—</em>"}</td>
        </tr>`).join("")}
      </table>
      <p style="margin-top:10px"><b>GitHub:</b> closed ${teamIssuesClosed.length} | merged ${teamMergedPrs.length} | commits ${teamCommits.length} | WIP ${inProgressGh.length} | blockers ${m.blocked.length}</p>
      <hr><p style="color:#888;font-size:12px">Auto-generated · <a href="https://workflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `Morning Briefing — ${projectName} — ${todayStr}`, html });

    res.json({
      ok: true,
      today: todayStr,
      yesterday_workday: yesterdayStr,
      members: memberRows.length,
      yesterday_done: memberRows.filter((l) => l.yesterdayDone && l.yesterdayDone !== "—").length,
      today_plan: memberRows.filter((l) => l.todayPlan && l.todayPlan !== "—").length,
      carryover: memberRows.filter((l) => l.yesterdayWip && l.yesterdayWip !== "—").length,
      team_github: { closed: teamIssuesClosed.length, merged: teamMergedPrs.length, commits: teamCommits.length },
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
