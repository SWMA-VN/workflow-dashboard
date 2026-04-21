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

    // === Config: team mapping + excluded users (clients, bots) ===
    const memberMap = (() => {
      try { return JSON.parse(process.env.MEMBER_MAP || "{}"); }
      catch { return {}; }
    })();
    const defaultMap = {
      "Duong N.": "sexybells",
      "Huy Huynh": "huynhtuanhuy",
      "Nathan C.": "khanwilson",
      "Hai L.": "hailh14",
      "CuongNQ": "cuonghanc",
    };
    const finalMap = Object.keys(memberMap).length ? memberMap : defaultMap;
    const excludedUsers = (process.env.EXCLUDED_USERS || "vamadeus").split(",").map((s) => s.trim().toLowerCase());

    // === Sheet: today's afternoon section ===
    const { day, error: sheetError } = await getDayActivity(target);
    const afternoon = (day && day.afternoon) || {};
    const morning = (day && day.morning) || {};

    // === GitHub: today's activity ===
    const m = await getMetrics({ days: 1 });

    // Exclude client/non-team users from team aggregate counts
    const isExcluded = (login) => login && excludedUsers.includes(login.toLowerCase());
    const teamMergedPrs = m.prs_merged.filter((p) => !isExcluded(p.user?.login));
    const teamCommits = m.commits.filter((c) => !isExcluded(c.author?.login || c.commit?.author?.name));
    const teamIssuesClosed = m.issues_closed.filter((i) => !(i.assignees || []).every((a) => isExcluded(a.login)));

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

    // Build GitHub activity map per user (for smart fallback when sheet is empty)
    const ghActByUser = {};
    const ensure = (login) => { if (!ghActByUser[login]) ghActByUser[login] = { merged: [], commits: 0, closed: [] }; };
    for (const p of teamMergedPrs) if (p.user?.login) { ensure(p.user.login); ghActByUser[p.user.login].merged.push(p); }
    for (const c of teamCommits) {
      const login = c.author?.login || c.commit?.author?.name;
      if (login) { ensure(login); ghActByUser[login].commits++; }
    }
    for (const i of teamIssuesClosed) for (const a of (i.assignees || [])) {
      if (a.login) { ensure(a.login); ghActByUser[a.login].closed.push(i); }
    }

    // Per-member open assigned issues (for WIP fallback)
    const openByUser = {};
    for (const i of realIssues) for (const a of (i.assignees || [])) {
      if (isExcluded(a.login)) continue;
      if (!openByUser[a.login]) openByUser[a.login] = [];
      openByUser[a.login].push(i);
    }

    // Build per-member lines — ALWAYS from team config (not sheet), combining sheet + GitHub
    const memberLines = Object.keys(finalMap).map((mb) => {
      const ghUser = finalMap[mb];
      const aft = afternoon[mb] || {};
      const morn = morning[mb] || {};
      const issues = aft.issues || morn.issues || "";
      const ghAct = ghActByUser[ghUser] || { merged: [], commits: 0, closed: [] };
      const ghOpen = openByUser[ghUser] || [];

      // DONE: prefer sheet, fallback to GitHub activity
      let done = aft.done || "";
      if (!done || done === "—") {
        const parts = [];
        if (ghAct.merged.length) parts.push(...ghAct.merged.slice(0, 3).map((p) => `Merged PR #${p.number}: ${p.title}`));
        if (ghAct.closed.length) parts.push(...ghAct.closed.slice(0, 2).map((i) => `Closed #${i.number}: ${i.title}`));
        if (!parts.length && ghAct.commits > 0) parts.push(`${ghAct.commits} commits (no PR merged yet)`);
        done = parts.join("\n") || "—";
      }

      // IN PROGRESS: prefer sheet, fallback to currently assigned open issues
      let inProg = aft.inProgress || "";
      if (!inProg || inProg === "—") {
        if (ghOpen.length) inProg = ghOpen.slice(0, 3).map((i) => `#${i.number}: ${i.title}`).join("\n");
        else inProg = "—";
      }

      // Status
      const hasDone = done && done !== "—";
      const hasWip = inProg && inProg !== "—";
      let status, statusTag;
      if (hasDone && !hasWip) { status = "shipped, capacity free"; statusTag = "[DONE]"; }
      else if (hasDone && hasWip) { status = "shipped + carrying over"; statusTag = "[DONE+WIP]"; }
      else if (!hasDone && hasWip) { status = "still working"; statusTag = "[WIP]"; }
      else if (ghAct.commits > 0) { status = `active (${ghAct.commits} commits, no merges yet)`; statusTag = "[ACTIVE]"; }
      else { status = "quiet today"; statusTag = "[QUIET]"; }
      if (issues) statusTag = "[ISSUE]";

      return { member: mb, done, inProgress: inProg, issues, status, statusTag, ghCommits: ghAct.commits };
    });

    const doneCount = memberLines.filter((l) => l.done && l.done !== "—").length;
    const wipCount = memberLines.filter((l) => l.inProgress && l.inProgress !== "—").length;
    const issuesCount = memberLines.filter((l) => l.issues).length;
    const teamCommitsTotal = memberLines.reduce((s, l) => s + (l.ghCommits || 0), 0);

    // Team focus snapshot (deterministic, no AI)
    const focusBlock = memberLines.map((l) => {
      const focus = pickFocus(l.done, l.inProgress);
      return `${l.statusTag} **${l.member}** — _${l.status}_\n> Focus: ${focus}`;
    }).join("\n\n");

    // ===== Build Discord post =====
    // Combined sheet + GitHub per-member (always has content, never "no entry")
    const doneText = memberLines
      .filter((l) => l.done && l.done !== "—")
      .map((l) => `**${l.member}**\n> ${truncate(l.done, 280)}`)
      .join("\n\n");

    const wipText = memberLines
      .filter((l) => l.inProgress && l.inProgress !== "—")
      .map((l) => `**${l.member}**\n> ${truncate(l.inProgress, 280)}`)
      .join("\n\n");

    const issuesText = memberLines
      .filter((l) => l.issues)
      .map((l) => `[ISSUE] **${l.member}**: ${truncate(l.issues, 200)}`)
      .join("\n");

    // Team-only GitHub aggregates (excludes client users like @vamadeus)
    const ghDoneList = teamMergedPrs.slice(0, 5).concat(teamIssuesClosed.slice(0, 5))
      .map((x) => `- [#${x.number}](${x.html_url}) ${truncate(x.title || "", 70)}`)
      .join("\n");

    const ghWipList = inProgressGh.slice(0, 8)
      .map((i) => `- [#${i.number}](${i.html_url}) ${truncate(i.title, 60)} — ${(i.assignees || []).map((a) => `@${a.login}`).join(", ")}`)
      .join("\n");

    const staleList = stale.slice(0, 5)
      .map((s) => `[STALE ${s.days}d] [#${s.number}](${s.url}) ${truncate(s.title, 55)} — ${s.assignees.map((a) => `@${a}`).join(", ") || "_unassigned_"}`)
      .join("\n");

    // === AI summary ===
    const prompt = `You are a PM assistant writing the END-OF-DAY check-in for ${projectName} on ${dateStr} (Hanoi).

TEAM ACTIVITY (combined sheet log + GitHub activity — NEVER say "empty" or "no data", ALWAYS analyze what happened):

Per-member (sheet entries take priority, GitHub activity fills gaps):
${memberLines.map((l) => `  ${l.member} [${l.statusTag}] ${l.status}: done="${l.done}", wip="${l.inProgress}", commits=${l.ghCommits}`).join("\n")}

Team-only GitHub activity today (excludes client users):
- PRs merged: ${teamMergedPrs.length} — titles: ${teamMergedPrs.slice(0, 8).map((p) => p.title).join(" | ")}
- Issues closed: ${teamIssuesClosed.length} — titles: ${teamIssuesClosed.slice(0, 5).map((i) => i.title).join(" | ")}
- Commits: ${teamCommitsTotal}
- Currently in progress: ${inProgressGh.length}
- Stale (3+ days): ${stale.length}
- Blockers: ${m.blocked.length}

Write 5-7 sentences:
1. What each member shipped today (mention names + actual feature/work, based on PR titles + commits)
2. What's rolling into tomorrow (key WIP)
3. Any risks or stale items to flag
4. One micro-celebration (specific)

IMPORTANT RULES:
- NEVER say "sheet was empty", "no manual logs", or "no data".
- If sheet is empty, analyze from PR titles, commits, and assignments instead.
- Always give a concrete summary based on the activity that DID happen.
- Mention specific PR titles and people by name.`;

    const aiSummary = await aiSummarize(prompt, { maxTokens: 1500 });

    const fields = [
      { name: `DELIVERY FOCUS — per member (${memberLines.length})`, value: truncate(focusBlock, 1024), inline: false },
    ];
    if (doneText) fields.push({ name: `DONE today (${doneCount} members)`, value: truncate(doneText, 1024), inline: false });
    if (wipText) fields.push({ name: `IN PROGRESS — rolling tomorrow (${wipCount} members)`, value: truncate(wipText, 1024), inline: false });
    if (issuesText) fields.push({ name: `Issues raised (${issuesCount})`, value: truncate(issuesText, 1024), inline: false });
    if (ghDoneList) fields.push({ name: `Team shipped today (${teamMergedPrs.length} PRs · ${teamCommitsTotal} commits)`, value: truncate(ghDoneList, 1024), inline: false });
    if (ghWipList) fields.push({ name: `Currently in-progress (${inProgressGh.length})`, value: truncate(ghWipList, 1024), inline: false });
    if (staleList) fields.push({ name: `Stale items (${stale.length})`, value: truncate(staleList, 1024), inline: false });

    // ===== AUTO-CLOSE stale unassigned cards >14 days =====
    const staleUnassigned = realIssues.filter((i) =>
      (i.assignees || []).length === 0 &&
      (Date.now() - new Date(i.updated_at).getTime()) > 14 * 86400000 &&
      !(i.labels || []).some((l) => l.name === "inbox-history")
    );
    if (staleUnassigned.length > 0) {
      for (const i of staleUnassigned.slice(0, 10)) {
        const repo = i.repository_url ? i.repository_url.replace("https://api.github.com/repos/", "") : process.env.GITHUB_REPO;
        try {
          await fetch(`https://api.github.com/repos/${repo}/issues/${i.number}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
            body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
          });
          await fetch(`https://api.github.com/repos/${repo}/issues/${i.number}/comments`, {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
            body: JSON.stringify({ body: "Auto-closed: unassigned for 14+ days. Reopen if still needed." }),
          });
        } catch (e) { /* skip */ }
      }
      fields.push({ name: `Auto-closed (${staleUnassigned.length} stale unassigned)`, value: staleUnassigned.slice(0, 5).map((i) => `#${i.number} ${i.title.slice(0, 60)}`).join("\n"), inline: false });
    }

    // ===== AUTO-PING: PRs waiting >2 days for review =====
    const longPrs = inProgressGh.length; // Already have open issues; need open PRs
    // Fetch open PRs for PR-ping
    let prPingText = "";
    try {
      const { listPulls } = await import("../../lib/github.js");
      const openPrs = await listPulls({ state: "open", days: 30 });
      const longWait = openPrs.filter((p) => !p.draft && (Date.now() - new Date(p.created_at).getTime()) > 2 * 86400000);
      if (longWait.length) {
        const pingLines = longWait.slice(0, 5).map((p) => {
          const days = ((Date.now() - new Date(p.created_at).getTime()) / 86400000).toFixed(1);
          const repo = p._repo || "";
          return `[#${p.number}](${p.html_url}) ${p.title.slice(0, 50)} — @${p.user?.login || "?"} — ${days}d`;
        });
        prPingText = pingLines.join("\n");
        fields.push({ name: `PRs waiting for review (${longWait.length})`, value: truncate(prPingText, 1024), inline: false });
        // Also post separate ping
        await postDiscord({
          embeds: [makeEmbed({
            title: `${longWait.length} PR${longWait.length === 1 ? "" : "s"} waiting >2 days for review`,
            description: prPingText,
            color: 0xF59E0B,
          })],
        });
      }
    } catch (e) { /* skip PR ping if fails */ }

    await postDiscord({
      content: `**End of Day Report — ${projectName}** — ${dateStr} (Hanoi)`,
      embeds: [
        makeEmbed({
          title: `EOD Report — ${dateStr}`,
          description: truncate(aiSummary, 1800),
          color: m.blocked.length || stale.length >= 3 || issuesCount ? 0xE74C3C : 0x16A085,
          fields,
        }),
      ],
    });

    // ===== Email =====
    const sheetDoneHtml = memberLines.filter((l) => l.done && l.done !== "—").length
      ? `<ul>${memberLines.filter((l) => l.done && l.done !== "—").map((l) => `<li><b>[${esc(l.statusTag.replace(/[\[\]]/g,""))}] ${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.done)}</pre></li>`).join("")}</ul>`
      : "";

    const sheetWipHtml = memberLines.filter((l) => l.inProgress && l.inProgress !== "—").length
      ? `<ul>${memberLines.filter((l) => l.inProgress && l.inProgress !== "—").map((l) => `<li><b>${esc(l.member)}</b><br><pre style="font-family:inherit;white-space:pre-wrap;margin:4px 0">${esc(l.inProgress)}</pre></li>`).join("")}</ul>`
      : "";

    const issuesHtml = memberLines.filter((l) => l.issues).length
      ? `<ul>${memberLines.filter((l) => l.issues).map((l) => `<li><b>${esc(l.member)}</b>: ${esc(l.issues)}</li>`).join("")}</ul>`
      : "";

    const html = `
      <html><body style="font-family: Arial, sans-serif; max-width: 760px;">
      <h2 style="color:#16A085">EOD Report — ${esc(projectName)}</h2>
      <p><b>${dateStr} 16:15 (Hanoi)</b> · scope: ${esc(sc.label)}</p>
      <h3>AI Summary</h3>
      <p style="background:#d1fae5;padding:12px;border-left:4px solid #16A085;white-space:pre-wrap">${esc(aiSummary)}</p>

      <h3>🎯 Delivery focus per member</h3>
      <ul>${memberLines.map((l) => `<li><b>[${esc(l.statusTag.replace(/[\[\]]/g, ''))}] ${esc(l.member)}</b> — <em>${esc(l.status)}</em><br>Focus: ${esc(pickFocus(l.done, l.inProgress))}</li>`).join("")}</ul>

      ${sheetDoneHtml ? `<h3>Done today (per team member)</h3>${sheetDoneHtml}` : ""}
      ${sheetWipHtml ? `<h3>In Progress → tomorrow</h3>${sheetWipHtml}` : ""}

      ${issuesHtml ? `<h3>🚨 Issues raised</h3>${issuesHtml}` : ""}

      ${sheetError ? `<p style="color:#888"><em>Sheet error: ${esc(sheetError)}</em></p>` : ""}

      <h3>Team activity on ${isoStr} (excludes client users)</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td>Issues closed (team)</td><td><b>${teamIssuesClosed.length}</b></td></tr>
        <tr><td>PRs merged (team)</td><td><b>${teamMergedPrs.length}</b></td></tr>
        <tr><td>Commits (team)</td><td><b>${teamCommitsTotal}</b></td></tr>
        <tr><td>Currently in progress</td><td><b>${inProgressGh.length}</b></td></tr>
        <tr><td>Stale (3+ days)</td><td><b>${stale.length}</b></td></tr>
        <tr><td>Blockers</td><td><b style="color:${m.blocked.length ? "red" : "green"}">${m.blocked.length}</b></td></tr>
      </table>

      <hr><p style="color:#888;font-size:12px">Auto-generated · <a href="https://ethanworkflowview.vercel.app">Dashboard</a></p>
      </body></html>`;
    await sendEmail({ subject: `EOD Report — ${projectName} — ${dateStr}`, html });

    res.json({
      ok: true,
      target_date: dateStr,
      team_members: Object.keys(finalMap).length,
      done_count: doneCount,
      wip_count: wipCount,
      issues_count: issuesCount,
      sheet_error: sheetError || null,
      team_github: {
        closed: teamIssuesClosed.length,
        merged: teamMergedPrs.length,
        commits: teamCommitsTotal,
      },
      all_github: {
        in_progress: inProgressGh.length,
        stale: stale.length,
        blocked: m.blocked.length,
      },
      excluded_users: excludedUsers,
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
