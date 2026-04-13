// GET /api/wip
// Returns WIP (work-in-progress) per dev: open issues count vs max_open from team config.
// Used by Overview tab to render WIP load bars.

import { listIssues } from "../lib/github.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    let team = {};
    try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}

    const openIssues = await listIssues({ state: "open" });
    const realIssues = openIssues.filter((i) => !i.pull_request);

    const wip = {};
    for (const dev of Object.keys(team)) {
      wip[dev] = {
        login: dev,
        skills: team[dev].skills || [],
        max_open: team[dev].max_open || 99,
        open_count: 0,
        issues: [],
      };
    }

    for (const issue of realIssues) {
      for (const a of issue.assignees || []) {
        if (wip[a.login]) {
          wip[a.login].open_count++;
          wip[a.login].issues.push({
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            updated_at: issue.updated_at,
          });
        }
      }
    }

    // Compute status + percent + days_since_update
    const now = Date.now();
    for (const dev of Object.values(wip)) {
      dev.percent = Math.round((dev.open_count / dev.max_open) * 100);
      dev.status =
        dev.open_count >= dev.max_open ? "overload" :
        dev.percent >= 50 ? "busy" :
        dev.percent > 0 ? "ok" : "idle";
      // Stale: oldest issue not updated in 3+ days
      dev.stale_count = dev.issues.filter((i) =>
        (now - new Date(i.updated_at).getTime()) > 3 * 86400000
      ).length;
    }

    // Team totals
    const total_wip = Object.values(wip).reduce((s, d) => s + d.open_count, 0);
    const total_capacity = Object.values(wip).reduce((s, d) => s + d.max_open, 0);

    res.json({
      generated_at: new Date().toISOString(),
      team_wip: total_wip,
      team_capacity: total_capacity,
      team_percent: total_capacity ? Math.round((total_wip / total_capacity) * 100) : 0,
      devs: Object.values(wip).sort((a, b) => b.percent - a.percent),
      unassigned_open: realIssues.filter((i) => !i.assignees.length).length,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
