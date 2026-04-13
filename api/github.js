// GET /api/github
// Returns Kanban-bucketed issues + metrics for dashboard.

import { listIssues, listPulls, getMetrics } from "../lib/github.js";

const COLUMNS = ["Todo", "In Progress", "In Review", "Testing", "Blocked", "Done"];

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(500).json({
        error: "Missing GITHUB_TOKEN or GITHUB_REPO env var",
        hint: "Set them in Vercel Dashboard → Settings → Environment Variables",
      });
    }

    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);
    const openPrs = openIssues.filter((i) => i.pull_request);
    const m = await getMetrics({ days: 30 });

    const cols = Object.fromEntries(COLUMNS.map((c) => [c, []]));

    for (const issue of realIssues) {
      const labels = (issue.labels || []).map((l) => l.name.toLowerCase());
      let col = "Todo";
      if (labels.includes("status:in-progress") || labels.includes("in progress")) col = "In Progress";
      else if (labels.includes("status:in-review") || labels.includes("in review")) col = "In Review";
      else if (labels.includes("status:testing") || labels.includes("testing")) col = "Testing";
      else if (labels.includes("blocked") || labels.includes("blocker")) col = "Blocked";
      if (col === "Todo" && (issue.assignees || []).length > 0) col = "In Progress";
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

    for (const pr of m.prs_merged.slice(0, 20)) {
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
      repo: process.env.GITHUB_REPO,
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
