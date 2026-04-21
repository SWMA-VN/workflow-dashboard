// Vercel Cron — runs Friday 17:00 Hanoi.
// Weekly report with velocity trend alert if velocity drops 30%+

import { getMetrics, listPulls, listMilestones, listCommits } from "../../lib/github.js";
import { aiSummarize } from "../../lib/ai.js";
import { postDiscord, makeEmbed } from "../../lib/discord.js";
import { sendEmail } from "../../lib/email.js";

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end();
  }

  try {
    const projectName = process.env.PROJECT_NAME || "Project";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.TIMEZONE || "Asia/Ho_Chi_Minh" });
    const m = await getMetrics({ days: 7 });
    const velocity = m.issues_closed.length + m.prs_merged.length;

    // ===== VELOCITY TREND ANALYSIS =====
    // Compare this week vs previous weeks (rolling 30-day window for baseline)
    const allPulls = await listPulls({ state: "closed", days: 35 });
    const merged = allPulls.filter((p) => p.merged_at);

    const now = Date.now();
    const week = 7 * 86400000;
    const weeklyVelocity = [];
    for (let i = 0; i < 4; i++) {
      const end = now - i * week;
      const start = end - week;
      const count = merged.filter((p) => {
        const t = new Date(p.merged_at).getTime();
        return t >= start && t < end;
      }).length;
      weeklyVelocity.push(count);
    }
    // [thisWeek, lastWeek, 2weeksAgo, 3weeksAgo]
    const thisWeek = weeklyVelocity[0];
    const prevWeeksAvg = (weeklyVelocity[1] + weeklyVelocity[2] + weeklyVelocity[3]) / 3;
    const dropPct = prevWeeksAvg > 0 ? Math.round(((prevWeeksAvg - thisWeek) / prevWeeksAvg) * 100) : 0;
    const hasVelocityDrop = prevWeeksAvg >= 2 && dropPct >= 30;

    const trendText = hasVelocityDrop
      ? `**Velocity DROP: -${dropPct}%** vs 3-week avg (${thisWeek} this week vs ${prevWeeksAvg.toFixed(1)} avg). Investigate blockers + on-call absences.`
      : dropPct <= -20
      ? `Velocity UP +${Math.abs(dropPct)}% vs 3-week avg. Strong week.`
      : `Velocity stable: ${thisWeek} this week vs ${prevWeeksAvg.toFixed(1)} avg.`;

    const prompt = `You are a PM assistant. Write a weekly status update (5-7 sentences) for stakeholders.

Data this week:
- Issues opened: ${m.issues_opened.length}
- Issues closed: ${m.issues_closed.length}
- PRs merged: ${m.prs_merged.length}
- In progress: ${m.in_progress.length}
- Blocked: ${m.blocked.length}
- Commits: ${m.commits.length}

Velocity trend: ${trendText}
Weekly PRs merged (most recent first): ${weeklyVelocity.join(", ")}

Top closed: ${m.issues_closed.slice(0, 8).map((i) => i.title).join("; ")}
Top merged PRs: ${m.prs_merged.slice(0, 8).map((p) => p.title).join("; ")}
Active blockers: ${m.blocked.map((i) => i.title).join("; ")}
Activity by person: ${JSON.stringify(m.by_person)}

Cover: progress this week, what's shipping next week, top 3 risks. If velocity dropped, identify likely cause.`;

    const summary = await aiSummarize(prompt, { maxTokens: 2048 });

    // ===== BURNOUT DETECTOR =====
    const allCommits = await listCommits({ days: 30 });
    const burnout = {};
    for (const c of allCommits) {
      const login = c.author?.login || c.commit?.author?.name || "unknown";
      if (!burnout[login]) burnout[login] = { weekend: 0, late: 0, total: 0 };
      burnout[login].total++;
      const d = new Date(c.commit.author.date || c.commit.committer.date);
      const hanoiHour = (d.getUTCHours() + 7) % 24;
      const hanoiDay = new Date(d.getTime() + 7 * 3600000).getDay();
      if (hanoiDay === 0 || hanoiDay === 6) burnout[login].weekend++;
      if (hanoiHour >= 22 || hanoiHour < 6) burnout[login].late++;
    }
    const burnoutAlerts = Object.entries(burnout)
      .filter(([_, s]) => s.weekend > 2 || s.late > 2)
      .map(([login, s]) => `${login}: ${s.weekend} weekend, ${s.late} late-night (of ${s.total} total)`)
      .join("\n");

    // ===== STAKEHOLDER ONE-PAGER =====
    const milestones = await listMilestones();
    const weeklyVel = m.prs_merged.length / 1; // per week
    const milestoneRows = milestones
      .filter((ml) => ml.open_issues + ml.closed_issues > 0)
      .slice(0, 5)
      .map((ml) => {
        const total = ml.open_issues + ml.closed_issues;
        const pct = total > 0 ? Math.round((ml.closed_issues / total) * 100) : 0;
        const weeksLeft = weeklyVel >= 0.1 ? Math.ceil(ml.open_issues / weeklyVel) : null;
        const forecast = weeksLeft !== null
          ? new Date(Date.now() + weeksLeft * 7 * 86400000).toISOString().slice(0, 10)
          : "TBD";
        const target = ml.due_on ? new Date(ml.due_on).toISOString().slice(0, 10) : "no deadline";
        return { title: ml.title, pct, total, closed: ml.closed_issues, target, forecast };
      });

    const topShipped = m.prs_merged.slice(0, 3).map((p) => p.title);
    const top3Risks = [];
    if (m.blocked.length) top3Risks.push(`${m.blocked.length} blocker${m.blocked.length === 1 ? "" : "s"}`);
    if (hasVelocityDrop) top3Risks.push(`velocity down ${dropPct}%`);
    const staleCount = m.issues_opened.filter(() => true).length;
    if (weeklyVelocity[1] === 0) top3Risks.push("no PRs merged last week");

    const stakeholderHtml = `
      <div style="background:#eff6ff;border:1px solid #2563eb;border-radius:8px;padding:16px;margin:20px 0">
        <h3 style="color:#1d4ed8;margin-top:0">Stakeholder One-Pager — safe to forward</h3>

        <h4>Shipped this week</h4>
        ${topShipped.length ? `<ul>${topShipped.map((t) => `<li>${t}</li>`).join("")}</ul>` : "<p><em>No merges this week.</em></p>"}

        <h4>Shipping next 4 weeks</h4>
        ${milestoneRows.length
          ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
              <tr><th>Project</th><th>Progress</th><th>Target</th><th>Forecast</th></tr>
              ${milestoneRows.map((r) => `<tr>
                <td>${r.title}</td>
                <td>${r.pct}% (${r.closed}/${r.total})</td>
                <td>${r.target}</td>
                <td>${r.forecast}</td>
              </tr>`).join("")}
            </table>`
          : "<p><em>No milestones defined.</em></p>"}

        <h4>Top risks</h4>
        ${top3Risks.length ? `<ul>${top3Risks.map((r) => `<li>${r}</li>`).join("")}</ul>` : "<p>No critical risks.</p>"}

        <h4>Key metrics</h4>
        <ul>
          <li>Velocity: <b>${velocity}</b> this week (avg ${prevWeeksAvg.toFixed(1)})</li>
          <li>Team throughput: <b>${m.prs_merged.length}</b> PRs merged</li>
          <li>Active work: <b>${m.in_progress.length}</b> in progress</li>
        </ul>

        ${burnoutAlerts ? `<h4>Team health signals (30d)</h4><pre style="font-family:inherit">${burnoutAlerts}</pre>` : ""}
      </div>
    `;

    // Discord: alert embed + weekly embed
    const embeds = [];

    if (hasVelocityDrop) {
      embeds.push(makeEmbed({
        title: `VELOCITY DROP ALERT — ${dropPct}% below average`,
        description: `**This week:** ${thisWeek} PRs merged\n**3-week avg:** ${prevWeeksAvg.toFixed(1)} PRs\n**Drop:** -${dropPct}%\n\nLikely causes to investigate: open blockers, team absences, large ongoing work, sprint scope mismatch.`,
        fields: [
          { name: "This week", value: String(thisWeek), inline: true },
          { name: "Last week", value: String(weeklyVelocity[1]), inline: true },
          { name: "2 weeks ago", value: String(weeklyVelocity[2]), inline: true },
          { name: "3 weeks ago", value: String(weeklyVelocity[3]), inline: true },
          { name: "Blockers open", value: String(m.blocked.length), inline: true },
          { name: "In progress", value: String(m.in_progress.length), inline: true },
        ],
        color: 0xE74C3C,
      }));
    }

    embeds.push(makeEmbed({
      title: `Weekly Report — ${today}`,
      description: summary.slice(0, 2000),
      fields: [
        { name: "Velocity (this week)", value: String(velocity), inline: true },
        { name: "Closed", value: String(m.issues_closed.length), inline: true },
        { name: "Merged", value: String(m.prs_merged.length), inline: true },
        { name: "In Progress", value: String(m.in_progress.length), inline: true },
        { name: "Blockers", value: String(m.blocked.length), inline: true },
        { name: "Commits", value: String(m.commits.length), inline: true },
        { name: "Trend", value: trendText.replace(/\*\*/g, ""), inline: false },
      ],
      color: hasVelocityDrop ? 0xE74C3C : (m.blocked.length >= 2 ? 0xF59E0B : 0x27AE60),
    }));

    await postDiscord({
      content: `**Weekly wrap-up for ${projectName} — week ending ${today}**`,
      embeds,
    });

    const personRows = Object.entries(m.by_person)
      .sort((a, b) => b[1].commits - a[1].commits)
      .map(([p, s]) => `<tr><td>${p}</td><td>${s.commits}</td><td>${s.prs}</td></tr>`)
      .join("");

    const alertHtml = hasVelocityDrop
      ? `<div style="background:#fee2e2;border-left:4px solid #dc2626;padding:14px;margin:16px 0">
           <b style="color:#dc2626">VELOCITY DROP ALERT — ${dropPct}% below average</b><br>
           This week: <b>${thisWeek}</b> PRs · 3-week avg: <b>${prevWeeksAvg.toFixed(1)}</b> PRs<br>
           Investigate blockers + absences.
         </div>`
      : "";

    const html = `
      <html><body style="font-family: Arial, sans-serif;">
      <h2 style="color:#1F4E79">Weekly Report — ${projectName}</h2>
      <p><b>Week ending ${today}</b></p>
      ${alertHtml}
      <h3>Executive Summary</h3>
      <p style="background:#f0f4f8;padding:12px;border-left:4px solid #1F4E79">${summary}</p>
      ${stakeholderHtml}
      <h3>Velocity Metrics</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><td><b>Velocity (this week)</b></td><td>${velocity}</td></tr>
        <tr><td>Issues closed</td><td>${m.issues_closed.length}</td></tr>
        <tr><td>PRs merged</td><td>${m.prs_merged.length}</td></tr>
        <tr><td>In progress</td><td>${m.in_progress.length}</td></tr>
        <tr><td>Blockers</td><td style="color:${m.blocked.length ? "red" : "green"}"><b>${m.blocked.length}</b></td></tr>
        <tr><td>Commits</td><td>${m.commits.length}</td></tr>
      </table>
      <h3>Weekly Velocity Trend (PRs merged per week)</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><th>This week</th><th>Last week</th><th>2 weeks ago</th><th>3 weeks ago</th><th>3-week avg</th><th>vs avg</th></tr>
        <tr>
          <td><b>${weeklyVelocity[0]}</b></td>
          <td>${weeklyVelocity[1]}</td>
          <td>${weeklyVelocity[2]}</td>
          <td>${weeklyVelocity[3]}</td>
          <td>${prevWeeksAvg.toFixed(1)}</td>
          <td style="color:${hasVelocityDrop ? 'red' : 'green'}"><b>${dropPct <= 0 ? "+" : "-"}${Math.abs(dropPct)}%</b></td>
        </tr>
      </table>
      <h3>Team Contributions</h3>
      <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">
        <tr><th>Person</th><th>Commits</th><th>PRs</th></tr>
        ${personRows}
      </table>
      <hr><p style="color:#888;font-size:12px">Auto-generated. <a href="https://workflowview.vercel.app">Open dashboard</a></p>
      </body></html>
    `;
    await sendEmail({ subject: `Weekly Report — ${projectName} — ${today}${hasVelocityDrop ? " [VELOCITY DROP]" : ""}`, html });

    res.json({
      ok: true,
      velocity,
      weekly_velocity: weeklyVelocity,
      prev_avg: prevWeeksAvg,
      drop_pct: dropPct,
      has_velocity_drop: hasVelocityDrop,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
