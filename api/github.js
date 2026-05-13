// GET /api/github
// Returns Kanban-bucketed issues + metrics for dashboard.

import { listIssues, listPulls, getMetrics, listMilestones } from "../lib/github.js";

const COLUMNS = ["Todo", "In Progress", "In Review", "Blocked", "Done"];

const GH_API = "https://api.github.com";
function ghHeaders() {
  return { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
}

const STATUS_LABELS = ["status:in-progress", "status:in-review", "status:testing"];

export default async function handler(req, res) {
  // POST = move card or plan sprint
  if (req.method === "POST") {
    const body = req.body || {};
    if (body.action === "plan-sprint") return handleSprintPlan(req, res);
    if (body.action === "comment") return handleComment(req, res);
    if (body.action === "chat") return handleChat(req, res);
    if (body.action === "send-discord") return handleSendDiscord(req, res);
    return handleMove(req, res);
  }

  // No auto-poll. Data fetched only on user action (Refresh, filter, tab switch).
  // No cache-busting from client. Vercel CDN caches 10 min for fast repeat loads.
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");
  try {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(500).json({
        error: "Missing GITHUB_TOKEN or GITHUB_REPO env var",
      });
    }

    // Time filter: ?days=7 | ?from=2026-04-20&to=2026-04-20 | ?days=0 (all)
    // All dates are Hanoi time (UTC+7). API converts to UTC for GitHub queries.
    const fromParam = req.query?.from;
    const toParam = req.query?.to;
    let daysParam, sinceUtc, toUtc;

    if (fromParam) {
      // Custom date range — convert Hanoi dates to UTC
      // Hanoi April 20 00:00 = UTC April 19 17:00
      sinceUtc = new Date(fromParam + "T00:00:00+07:00").toISOString();
      toUtc = toParam
        ? new Date(toParam + "T23:59:59+07:00").toISOString()
        : new Date().toISOString();
      daysParam = Math.ceil((new Date(toUtc) - new Date(sinceUtc)) / 86400000);
    } else {
      daysParam = parseInt(req.query?.days) || 7;
      const doneDays = daysParam === 0 ? 365 * 3 : daysParam;
      sinceUtc = new Date(Date.now() - doneDays * 86400000).toISOString();
      toUtc = new Date().toISOString();
    }

    const openIssues = await listIssues({ state: "open" });
    const isLog = (i) => (i.labels || []).some((l) => l.name === "inbox-history");
    const realIssues = openIssues.filter((i) => !i.pull_request && !isLog(i));
    const openPrs = openIssues.filter((i) => i.pull_request);

    // Fetch closed issues for Done column (Hanoi timezone-aware)
    const closedIssues = await listIssues({ state: "closed", since: sinceUtc });
    const sinceMs = new Date(sinceUtc).getTime();
    const toMs = new Date(toUtc).getTime();
    const recentlyClosed = closedIssues.filter((i) => {
      if (i.pull_request || isLog(i) || !i.closed_at) return false;
      const t = new Date(i.closed_at).getTime();
      return t >= sinceMs && t <= toMs;
    });
    const m = await getMetrics({ days: 30 });

    const cols = Object.fromEntries(COLUMNS.map((c) => [c, []]));

    // Filter open issues by updated_at within the selected time period
    const filterOpenMs = new Date(sinceUtc).getTime();

    for (const issue of realIssues) {
      // Skip open issues not updated within the filter period
      const updatedMs = new Date(issue.updated_at).getTime();
      if (updatedMs < filterOpenMs) continue;

      const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
      let col = "Todo";

      if (labels.includes("block") || labels.includes("blocked") || labels.includes("blocker")) {
        col = "Blocked";
      } else if (labels.includes("status:testing") || labels.includes("status:in-review")) {
        col = "In Review";
      } else if (labels.includes("status:in-progress")) {
        col = "In Progress";
      } else if ((issue.assignees || []).length > 0) {
        col = "In Progress";
      }

      cols[col].push(simplifyIssue(issue));
    }

    for (const pr of openPrs) {
      if (new Date(pr.updated_at).getTime() < filterOpenMs) continue;
      cols["In Review"].push({
        number: pr.number,
        title: `PR: ${pr.title}`,
        url: pr.html_url,
        assignees: (pr.assignees || []).map((a) => a.login),
        labels: ["pull-request"],
        updated_at: pr.updated_at,
        created_at: pr.created_at,
      });
    }

    // Done: recently closed issues + merged PRs
    for (const issue of recentlyClosed) {
      cols["Done"].push(simplifyIssue(issue));
    }
    for (const pr of m.prs_merged.slice(0, 10)) {
      cols["Done"].push({
        number: pr.number,
        title: `PR: ${pr.title}`,
        url: pr.html_url,
        assignees: [pr.user.login],
        labels: ["merged"],
        updated_at: pr.merged_at,
        created_at: pr.created_at,
      });
    }

    // ===== MILESTONES + FORECASTING =====
    const milestones = await listMilestones();
    const weeklyVelocity = m.prs_merged.length / Math.max(1, daysParam / 7); // PRs/week baseline
    const milestoneData = milestones.map((ml) => {
      const total = ml.open_issues + ml.closed_issues;
      const percent = total > 0 ? Math.round((ml.closed_issues / total) * 100) : 0;
      const remaining = ml.open_issues;

      // Forecast: weeks_to_ship = remaining / velocity_per_week
      let forecast = null, status = "on-track", daysOffset = 0;
      if (total === 0) {
        status = "empty";
      } else if (remaining === 0) {
        status = "done";
      } else if (weeklyVelocity >= 0.1) {
        const weeksToShip = remaining / weeklyVelocity;
        forecast = new Date(Date.now() + weeksToShip * 7 * 86400000).toISOString();
        if (ml.due_on) {
          const target = new Date(ml.due_on).getTime();
          const fc = new Date(forecast).getTime();
          daysOffset = Math.round((fc - target) / 86400000);
          if (daysOffset > 3) status = "late";
          else if (daysOffset > 0) status = "at-risk";
        }
      }

      // Risk predictor (deterministic, no AI)
      let riskScore = 0;
      const risks = [];
      if (ml.due_on && daysOffset > 3) { riskScore += 30; risks.push(`${daysOffset}d behind target`); }
      if (status === "empty") { riskScore += 10; risks.push("no issues assigned"); }
      if (remaining > 0 && ml.due_on) {
        const daysLeft = (new Date(ml.due_on).getTime() - Date.now()) / 86400000;
        if (daysLeft < 14 && percent < 50) { riskScore += 25; risks.push(`${Math.round(daysLeft)}d left but only ${percent}% done`); }
      }
      const riskLevel = riskScore >= 40 ? "high" : riskScore >= 15 ? "medium" : "low";

      return {
        number: ml.number,
        title: ml.title,
        description: ml.description || "",
        repo: ml._repo || process.env.GITHUB_REPO,
        url: ml.html_url,
        total, remaining, closed: ml.closed_issues,
        percent,
        due_on: ml.due_on,
        forecast,
        days_offset: daysOffset,
        status,
        risk: { score: riskScore, level: riskLevel, factors: risks },
      };
    }).sort((a, b) => {
      // At-risk first, then by due date
      const order = { "late": 0, "at-risk": 1, "on-track": 2, "done": 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return (a.due_on || "9") < (b.due_on || "9") ? -1 : 1;
    });

    // ===== TEAM HEALTH SCORE (0-100) =====
    // Combines: velocity trend, cycle time, WIP balance, blockers, review lag, stale count
    const healthFactors = [];
    let healthTotal = 0;

    // 1. Velocity trend (25 pts): stable or up = good
    const velScore = m.prs_merged.length > 0 ? Math.min(25, Math.round(m.prs_merged.length / 2)) : 5;
    healthFactors.push({ name: "Velocity", score: velScore, max: 25, detail: `${m.prs_merged.length} PRs merged` });
    healthTotal += velScore;

    // 2. Blockers (20 pts): 0 = 20, each blocker -10
    const blockScore = Math.max(0, 20 - m.blocked.length * 10);
    healthFactors.push({ name: "Blockers", score: blockScore, max: 20, detail: `${m.blocked.length} blocked` });
    healthTotal += blockScore;

    // 3. WIP balance (20 pts): under 80% utilization = good
    let team = {};
    try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}
    const teamDevs = Object.keys(team);
    const totalCap = teamDevs.reduce((s, d) => s + (team[d].max_open || 3), 0) || 15;
    const totalWip = realIssues.filter((i) => (i.assignees || []).length > 0).length;
    const wipPct = totalCap ? totalWip / totalCap : 0;
    const wipScore = wipPct <= 0.6 ? 20 : wipPct <= 0.8 ? 15 : wipPct <= 1.0 ? 10 : 5;
    healthFactors.push({ name: "WIP Balance", score: wipScore, max: 20, detail: `${Math.round(wipPct * 100)}% utilized` });
    healthTotal += wipScore;

    // 4. Review lag (20 pts): fewer stale PRs = better
    const stalePrCount = openPrs.filter((p) => (Date.now() - new Date(p.updated_at).getTime()) > 2 * 86400000).length;
    const reviewScore = stalePrCount === 0 ? 20 : stalePrCount <= 2 ? 14 : stalePrCount <= 4 ? 8 : 3;
    healthFactors.push({ name: "Review Speed", score: reviewScore, max: 20, detail: `${stalePrCount} PRs waiting >2d` });
    healthTotal += reviewScore;

    // 5. Freshness (15 pts): fewer stale issues = better
    const staleIssueCount = realIssues.filter((i) => (Date.now() - new Date(i.updated_at).getTime()) > 3 * 86400000).length;
    const freshScore = staleIssueCount === 0 ? 15 : staleIssueCount <= 3 ? 11 : staleIssueCount <= 8 ? 6 : 2;
    healthFactors.push({ name: "Freshness", score: freshScore, max: 15, detail: `${staleIssueCount} stale issues` });
    healthTotal += freshScore;

    const healthGrade = healthTotal >= 80 ? "excellent" : healthTotal >= 60 ? "good" : healthTotal >= 40 ? "fair" : "poor";

    // ===== CAPACITY PLANNER =====
    const capacity = {
      total_slots: totalCap,
      committed: totalWip,
      available: Math.max(0, totalCap - totalWip),
      utilization_pct: totalCap ? Math.round((totalWip / totalCap) * 100) : 0,
      overloaded: totalWip > totalCap,
      per_dev: teamDevs.map((d) => {
        const open = realIssues.filter((i) => (i.assignees || []).some((a) => a.login === d)).length;
        const max = team[d].max_open || 3;
        return { login: d, open, max, available: Math.max(0, max - open), overloaded: open > max };
      }),
      recommendation: totalWip > totalCap
        ? `Team overloaded by ${totalWip - totalCap} tasks. Reassign or defer.`
        : totalWip > totalCap * 0.8
        ? `${totalCap - totalWip} slots left. Near capacity.`
        : `${totalCap - totalWip} slots available. Room for new work.`,
    };

    // ===== BURNDOWN (per milestone) =====
    const burndownData = milestoneData.filter((ml) => ml.due_on && ml.total > 0).map((ml) => {
      // Simple burndown: total issues, closed over time
      return { title: ml.title, total: ml.total, closed: ml.closed, remaining: ml.remaining, due_on: ml.due_on, percent: ml.percent };
    });

    // ===== NL SEARCH (if ?nlq= param) =====
    let nlSearchResult = null;
    const nlq = req.query?.nlq;
    if (nlq) {
      try {
        const { aiSummarize } = await import("../lib/ai.js");
        const prompt = `Parse this search query into filters. Query: "${nlq}"
Return JSON: {"assignee":"username or empty","repo":"repo-name or empty","label":"label or empty","text":"keyword"}
Only JSON, nothing else.`;
        const raw = await aiSummarize(prompt, { maxTokens: 200 });
        nlSearchResult = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      } catch (e) { nlSearchResult = null; }
    }

    res.json({
      generated_at: new Date().toISOString(),
      repo: process.env.GITHUB_REPO || process.env.GITHUB_ORG,
      filter_days: daysParam,
      filter_from: fromParam || null,
      filter_to: toParam || null,
      health: { score: healthTotal, grade: healthGrade, factors: healthFactors },
      capacity,
      burndown: burndownData,
      nl_search: nlSearchResult,
      milestones: milestoneData,
      velocity_per_week: +weeklyVelocity.toFixed(1),
      metrics: {
        velocity_30d: m.prs_merged.length,
        in_progress: m.in_progress.length,
        in_review: openPrs.length,
        blocked: m.blocked.length,
        merged_30d: m.prs_merged.length,
        commits_30d: m.commits.length,
      },
      by_person: m.by_person,
      columns: cols,
    });
  } catch (e) {
    console.error(e);
    const msg = e.message || "";
    if (msg.includes("403") || msg.includes("rate limit")) {
      res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
      return res.status(429).json({
        error: "GitHub API rate limit reached. Dashboard will auto-recover in a few minutes.",
        retry_after_seconds: 120,
      });
    }
    res.status(500).json({ error: e.message });
  }
}

// POST handler: move issue between Kanban columns
async function handleMove(req, res) {
  try {
    const { repo, issue, column } = req.body || {};
    if (!repo || !issue || !column) return res.status(400).json({ error: "need repo, issue, column" });

    const labelMap = {
      "Todo": null, // remove all status labels
      "In Progress": "status:in-progress",
      "In Review": "status:in-review",
      "Testing": "status:testing",
      "Blocked": "Block",
      "Done": null, // close issue
    };
    const targetLabel = labelMap[column];

    // Remove all existing status labels + Block
    for (const label of [...STATUS_LABELS, "Block"]) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE", headers: ghHeaders(),
      }).catch(() => {});
    }

    // Add new label (if not Todo/Done)
    if (targetLabel) {
      await fetch(`${GH_API}/repos/${repo}/issues/${issue}/labels`, {
        method: "POST", headers: ghHeaders(),
        body: JSON.stringify({ labels: [targetLabel] }),
      });
    }

    // Close if Done, reopen if moving out of Done
    if (column === "Done") {
      await fetch(`${GH_API}/repos/${repo}/issues/${issue}`, {
        method: "PATCH", headers: ghHeaders(),
        body: JSON.stringify({ state: "closed" }),
      });
    } else {
      await fetch(`${GH_API}/repos/${repo}/issues/${issue}`, {
        method: "PATCH", headers: ghHeaders(),
        body: JSON.stringify({ state: "open" }),
      });
    }

    res.json({ ok: true, issue, column });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// AI Sprint Planner
async function handleSprintPlan(req, res) {
  try {
    const { aiSummarize } = await import("../lib/ai.js");
    const openIssues = await listIssues({ state: "open" });
    const backlog = openIssues
      .filter((i) => !i.pull_request && !(i.labels || []).some((l) => l.name === "inbox-history"))
      .map((i) => {
        const repo = (i.repository_url || "").replace("https://api.github.com/repos/", "").split("/").pop();
        const labels = (i.labels || []).map((l) => l.name);
        const prio = labels.find((l) => ["p0", "p1", "p2"].includes(l)) || "p2";
        return { number: i.number, title: i.title, repo, assignees: (i.assignees || []).map((a) => a.login), labels, prio, url: i.html_url };
      });

    let team = {};
    try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}
    const teamInfo = Object.entries(team).map(([u, c]) => `${u}: skills=${(c.skills||[]).join(",")}, max=${c.max_open}`).join("\n");

    const prompt = `Pick 8 issues for next sprint from this backlog. Return JSON array only.

Backlog:
${backlog.slice(0, 30).map((i) => `${i.number}: [${i.prio}] ${i.title}`).join("\n")}

Team: ${Object.keys(team).join(", ")}

Reply format (JSON array, nothing else):
[{"number":42,"reason":"high priority"},{"number":15,"reason":"quick win"}]`;

    const raw = await aiSummarize(prompt, { maxTokens: 1500 });
    let plan = [];
    try {
      const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      plan = JSON.parse(cleaned);
    } catch (e) {
      plan = [];
    }

    // Enrich with issue details
    const enriched = plan.map((p) => {
      const issue = backlog.find((i) => i.number === p.number);
      return issue ? { ...p, title: issue.title, repo: issue.repo, prio: issue.prio, assignees: issue.assignees, url: issue.url } : p;
    }).filter((p) => p.title);

    res.json({ ok: true, sprint_plan: enriched, backlog_size: backlog.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleChat(req, res) {
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: "need question" });

    const { aiSummarize } = await import("../lib/ai.js");

    // Gather live context
    const m = await getMetrics({ days: 7 });
    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const milestones = await listMilestones();

    let team = {};
    try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}
    const excludedUsers = (process.env.EXCLUDED_USERS || "vamadeus").split(",").map((s) => s.trim().toLowerCase());
    const isExcluded = (l) => l && excludedUsers.includes(l.toLowerCase());

    const teamMerged = m.prs_merged.filter((p) => !isExcluded(p.user?.login));
    const teamCommits = m.commits.filter((c) => !isExcluded(c.author?.login));

    // Per-dev summary
    const devStats = {};
    for (const d of Object.keys(team)) {
      const open = realIssues.filter((i) => (i.assignees || []).some((a) => a.login === d)).length;
      const merged = teamMerged.filter((p) => p.user?.login === d).length;
      const commits = teamCommits.filter((c) => c.author?.login === d).length;
      devStats[d] = { open, merged, commits, max: team[d].max_open || 3, skills: (team[d].skills || []).join(",") };
    }

    const msInfo = milestones.map((ml) => {
      const total = ml.open_issues + ml.closed_issues;
      const pct = total > 0 ? Math.round((ml.closed_issues / total) * 100) : 0;
      return `${ml.title}: ${pct}% (${ml.closed_issues}/${total}) due=${ml.due_on || "no date"}`;
    }).join("\n");

    const blocked = realIssues.filter((i) => (i.labels || []).some((l) => /block/i.test(l.name)));
    const stale = realIssues.filter((i) => (Date.now() - new Date(i.updated_at).getTime()) > 3 * 86400000);

    const context = `You are a PM assistant for SWMA-VN org. Answer the question using ONLY this live data. Be concise (max 4 sentences).

TEAM (last 7 days):
${Object.entries(devStats).map(([d, s]) => `${d}: ${s.open} open (max ${s.max}), ${s.merged} PRs merged, ${s.commits} commits, skills: ${s.skills}`).join("\n")}

GITHUB (7d): ${teamMerged.length} PRs merged, ${teamCommits.length} commits, ${m.issues_closed.length} closed, ${realIssues.length} open, ${blocked.length} blocked, ${stale.length} stale (3d+)

MILESTONES:
${msInfo || "none"}

Top merged PRs: ${teamMerged.slice(0, 8).map((p) => `${p.user?.login}: ${p.title}`).join(" | ")}

Question: "${question}"

Answer concisely. Use names and numbers. No filler.`;

    const answer = await aiSummarize(context, { maxTokens: 500 });
    res.json({ ok: true, answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function handleSendDiscord(req, res) {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "need text" });
    const { postDiscord, makeEmbed } = await import("../lib/discord.js");
    await postDiscord({
      embeds: [makeEmbed({
        title: "PM Report",
        description: text.slice(0, 2000),
        color: 0x2563EB,
      })],
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function handleComment(req, res) {
  try {
    const { repo, issue, body: commentBody } = req.body || {};
    if (!repo || !issue || !commentBody) return res.status(400).json({ error: "need repo, issue, body" });
    const r = await fetch(`${GH_API}/repos/${repo}/issues/${issue}/comments`, {
      method: "POST", headers: ghHeaders(),
      body: JSON.stringify({ body: commentBody }),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function simplifyIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    assignees: (issue.assignees || []).map((a) => a.login),
    labels: (issue.labels || []).map((l) => l.name),
    updated_at: issue.updated_at,
    created_at: issue.created_at,
  };
}
