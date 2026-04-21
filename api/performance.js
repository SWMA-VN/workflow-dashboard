// GET /api/performance
// Returns cycle time, throughput per dev, quality, weekly velocity sparkline.
// Used by Performance tab.

import { listPulls, listIssues, listCommits } from "../lib/github.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  try {
    // Pull merged PRs from last 60 days for cycle time analysis
    const allPulls = await listPulls({ state: "closed", days: 60 });
    const mergedPrs = allPulls.filter((p) => p.merged_at);

    // === CYCLE TIME ===
    // Time from PR.created_at → PR.merged_at (in days)
    const cycleTimes = mergedPrs
      .map((p) => (new Date(p.merged_at) - new Date(p.created_at)) / 86400000)
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);

    const percentile = (arr, p) => {
      if (!arr.length) return null;
      const idx = Math.min(Math.floor(arr.length * p), arr.length - 1);
      return arr[idx];
    };
    const cycle = {
      sample_size: cycleTimes.length,
      p50: percentile(cycleTimes, 0.5),
      p90: percentile(cycleTimes, 0.9),
      mean: cycleTimes.length ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length : null,
    };

    // === WEEKLY VELOCITY (last 4 full weeks) ===
    const now = Date.now();
    const weeks = [];
    for (let i = 3; i >= 0; i--) {
      const start = now - (i + 1) * 7 * 86400000;
      const end = now - i * 7 * 86400000;
      const merged = mergedPrs.filter((p) => {
        const t = new Date(p.merged_at).getTime();
        return t >= start && t < end;
      });
      weeks.push({
        label: `W-${i}`,
        starts_at: new Date(start).toISOString(),
        merged: merged.length,
      });
    }

    // === THROUGHPUT PER DEV (PRs merged per dev, last 30 days) ===
    const cutoff30 = now - 30 * 86400000;
    const throughput = {};
    for (const pr of mergedPrs) {
      if (new Date(pr.merged_at).getTime() < cutoff30) continue;
      const login = pr.user.login;
      if (!throughput[login]) throughput[login] = { login, prs_merged: 0, total_cycle: 0 };
      throughput[login].prs_merged++;
      throughput[login].total_cycle += (new Date(pr.merged_at) - new Date(pr.created_at)) / 86400000;
    }
    for (const t of Object.values(throughput)) {
      t.avg_cycle_days = t.prs_merged ? +(t.total_cycle / t.prs_merged).toFixed(1) : 0;
      delete t.total_cycle;
    }

    // === QUALITY (bugs filed in last 30d / PRs merged in last 30d) ===
    const recentIssues = await listIssues({ state: "all", since: new Date(cutoff30).toISOString() });
    const recentBugs = recentIssues.filter((i) =>
      !i.pull_request &&
      (i.labels || []).some((l) => /bug|regression|defect/i.test(l.name))
    );
    const merged30 = mergedPrs.filter((p) => new Date(p.merged_at).getTime() >= cutoff30).length;
    const quality = {
      bugs_30d: recentBugs.length,
      merged_30d: merged30,
      bug_rate_percent: merged30 ? Math.round((recentBugs.length / merged30) * 100) : 0,
      health: !merged30 ? "no-data" :
              recentBugs.length / merged30 < 0.1 ? "good" :
              recentBugs.length / merged30 < 0.2 ? "ok" : "warning",
    };

    // === STALE TICKETS ===
    const openIssues = await listIssues({ state: "open" });
    const stale = openIssues
      .filter((i) => !i.pull_request)
      .filter((i) => (Date.now() - new Date(i.updated_at).getTime()) > 3 * 86400000)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        assignees: (i.assignees || []).map((a) => a.login),
        days_stale: Math.floor((Date.now() - new Date(i.updated_at).getTime()) / 86400000),
        labels: (i.labels || []).map((l) => l.name),
      }))
      .sort((a, b) => b.days_stale - a.days_stale)
      .slice(0, 20);

    // === COMMIT HEATMAP (last 30 days, commits per dev per day) ===
    const commits = await listCommits({ days: 30 });
    const heatmap = {};
    for (const c of commits) {
      const login = c.author?.login || c.commit.author.name || "unknown";
      const day = (c.commit.author.date || c.commit.committer.date).slice(0, 10);
      if (!heatmap[login]) heatmap[login] = {};
      heatmap[login][day] = (heatmap[login][day] || 0) + 1;
    }

    // ===== PR REVIEW BACKLOG =====
    // PRs currently open, sorted by how long they've been waiting
    const openPulls = await listPulls({ state: "open", days: 60 });
    const reviewBacklog = openPulls
      .filter((p) => !p.draft)
      .map((p) => {
        const ageDays = (Date.now() - new Date(p.created_at).getTime()) / 86400000;
        const staleDays = (Date.now() - new Date(p.updated_at).getTime()) / 86400000;
        return {
          number: p.number,
          title: p.title,
          url: p.html_url,
          author: p.user?.login || "unknown",
          repo: p._repo || process.env.GITHUB_REPO,
          age_days: +ageDays.toFixed(1),
          stale_days: +staleDays.toFixed(1),
          severity: ageDays > 3 ? "red" : ageDays > 1 ? "yellow" : "green",
        };
      })
      .sort((a, b) => b.age_days - a.age_days);

    const backlogSummary = {
      total_open: reviewBacklog.length,
      waiting_over_1d: reviewBacklog.filter((p) => p.age_days > 1).length,
      waiting_over_3d: reviewBacklog.filter((p) => p.age_days > 3).length,
      median_wait: reviewBacklog.length
        ? +reviewBacklog[Math.floor(reviewBacklog.length / 2)].age_days.toFixed(1)
        : 0,
      health: reviewBacklog.filter((p) => p.age_days > 3).length === 0 ? "good"
        : reviewBacklog.filter((p) => p.age_days > 3).length <= 2 ? "ok" : "slow",
    };

    // ===== BURNOUT DETECTOR =====
    // Flag devs with weekend or after-hours commits (10 PM - 6 AM Hanoi = 3 PM - 11 PM UTC)
    const burnoutSignals = {};
    for (const c of commits) {
      const login = c.author?.login || c.commit.author.name || "unknown";
      if (!burnoutSignals[login]) burnoutSignals[login] = { weekend: 0, late_night: 0, total: 0 };
      burnoutSignals[login].total++;

      const dateStr = c.commit.author.date || c.commit.committer.date;
      const d = new Date(dateStr);
      // Convert to Hanoi time (UTC+7)
      const hanoiHour = (d.getUTCHours() + 7) % 24;
      const hanoiDay = new Date(d.getTime() + 7 * 3600000).getDay(); // 0=Sun, 6=Sat

      if (hanoiDay === 0 || hanoiDay === 6) burnoutSignals[login].weekend++;
      if (hanoiHour >= 22 || hanoiHour < 6) burnoutSignals[login].late_night++;
    }

    const burnoutAlerts = Object.entries(burnoutSignals)
      .filter(([_, s]) => s.weekend > 0 || s.late_night > 0)
      .map(([login, s]) => ({
        login,
        weekend_commits: s.weekend,
        late_night_commits: s.late_night,
        total_commits: s.total,
        weekend_pct: s.total > 0 ? Math.round((s.weekend / s.total) * 100) : 0,
        risk: (s.weekend > 5 || s.late_night > 5) ? "high" : (s.weekend > 2 || s.late_night > 2) ? "medium" : "low",
      }))
      .sort((a, b) => (b.weekend_commits + b.late_night_commits) - (a.weekend_commits + a.late_night_commits));

    res.json({
      generated_at: new Date().toISOString(),
      cycle_time_days: {
        p50: cycle.p50 != null ? +cycle.p50.toFixed(1) : null,
        p90: cycle.p90 != null ? +cycle.p90.toFixed(1) : null,
        mean: cycle.mean != null ? +cycle.mean.toFixed(1) : null,
        sample_size: cycle.sample_size,
        health: cycle.p50 == null ? "no-data" :
                cycle.p50 <= 3 ? "good" :
                cycle.p50 <= 7 ? "ok" : "slow",
      },
      velocity_sparkline: weeks,
      throughput_per_dev: Object.values(throughput).sort((a, b) => b.prs_merged - a.prs_merged),
      quality,
      stale_tickets: stale,
      commit_heatmap: heatmap,
      review_backlog: reviewBacklog.slice(0, 20),
      review_backlog_summary: backlogSummary,
      burnout_alerts: burnoutAlerts,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
