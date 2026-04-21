// GET /api/github
// Returns Kanban-bucketed issues + metrics for dashboard.

import { listIssues, listPulls, getMetrics, listMilestones } from "../lib/github.js";

const COLUMNS = ["Todo", "In Progress", "In Review", "Testing", "Blocked", "Done"];

export default async function handler(req, res) {
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

    for (const issue of realIssues) {
      const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
      let col = "Todo";

      // Priority: blocked > status labels > assignee fallback
      if (labels.includes("block") || labels.includes("blocked") || labels.includes("blocker")) {
        col = "Blocked";
      } else if (labels.includes("status:testing")) {
        col = "Testing";
      } else if (labels.includes("status:in-review")) {
        col = "In Review";
      } else if (labels.includes("status:in-progress")) {
        col = "In Progress";
      } else if ((issue.assignees || []).length > 0) {
        // Assigned but no status label yet → In Progress
        col = "In Progress";
      }

      cols[col].push(simplifyIssue(issue));
    }

    for (const pr of openPrs) {
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
      if (remaining === 0) {
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
      };
    }).sort((a, b) => {
      // At-risk first, then by due date
      const order = { "late": 0, "at-risk": 1, "on-track": 2, "done": 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return (a.due_on || "9") < (b.due_on || "9") ? -1 : 1;
    });

    res.json({
      generated_at: new Date().toISOString(),
      repo: process.env.GITHUB_REPO || process.env.GITHUB_ORG,
      filter_days: daysParam,
      filter_from: fromParam || null,
      filter_to: toParam || null,
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
