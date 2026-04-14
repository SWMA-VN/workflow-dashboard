// GET /api/github
// Returns Kanban-bucketed issues + metrics for dashboard.

import { listIssues, listPulls, getMetrics } from "../lib/github.js";

const COLUMNS = ["Todo", "In Progress", "In Review", "Testing", "Blocked", "Done"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");
  try {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(500).json({
        error: "Missing GITHUB_TOKEN or GITHUB_REPO env var",
      });
    }

    // Time filter: ?days=7 (default), ?days=30, ?days=90, ?days=365, ?days=0 (all time)
    const daysParam = parseInt(req.query?.days) || 7;
    const doneDays = daysParam === 0 ? 365 * 3 : daysParam; // 0 = all time (max 3 years)

    const openIssues = await listIssues({ state: "open" });
    const isLog = (i) => (i.labels || []).some((l) => l.name === "inbox-history");
    const realIssues = openIssues.filter((i) => !i.pull_request && !isLog(i));
    const openPrs = openIssues.filter((i) => i.pull_request);

    // Fetch closed issues for Done column (controlled by time filter)
    const sinceDate = new Date(Date.now() - doneDays * 86400000).toISOString();
    const closedIssues = await listIssues({ state: "closed", since: sinceDate });
    const recentlyClosed = closedIssues.filter((i) =>
      !i.pull_request && !isLog(i) &&
      i.closed_at && new Date(i.closed_at).getTime() > Date.now() - doneDays * 86400000
    );
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

    res.json({
      generated_at: new Date().toISOString(),
      repo: process.env.GITHUB_REPO || process.env.GITHUB_ORG,
      filter_days: daysParam,
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
