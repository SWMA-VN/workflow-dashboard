// Auto-assignment engine.
//
// Rules (in order):
//   1. Parse issue title/body/labels for skill keywords (frontend, backend, qa, etc.)
//   2. Find devs whose `skills` array intersects with required skills
//   3. Among matched devs, pick one with FEWEST currently-open assigned issues
//   4. Skip devs already at `max_open` workload — fall back to next best match
//   5. If no skill match, pick least-loaded dev across team (round-robin fallback)
//
// Team config in env TEAM_CONFIG (JSON):
//   {"alice": {"skills": ["frontend","react"], "max_open": 3}, "bob": {...}}

import { listIssues, assignIssue, commentIssue } from "./github.js";

const SKILL_KEYWORDS = {
  frontend: ["frontend", "ui", "ux", "react", "vue", "css", "html", "tailwind", "step-0", "step-1", "step-2", "step-3"],
  backend: ["backend", "api", "server", "database", "db", "sql", "node", "python", "express", "endpoint"],
  mobile: ["mobile", "ios", "android", "react-native", "flutter", "swift", "kotlin", "app"],
  payment: ["hitpay", "wechat", "fps", "payment", "stripe", "checkout"],
  qa: ["qa", "test", "test-case", "tc-", "bug"],
  devops: ["devops", "ci", "cd", "deploy", "vercel", "github-actions", "docker", "pipeline"],
  integration: ["bydesign", "webhook", "integration", "third-party"],
};

function loadTeam() {
  try {
    return JSON.parse(process.env.TEAM_CONFIG || "{}");
  } catch (e) {
    console.error("[assign] Bad TEAM_CONFIG JSON");
    return {};
  }
}

function detectSkills(issue) {
  const text = `${issue.title} ${issue.body || ""} ${(issue.labels || []).map((l) => l.name).join(" ")}`.toLowerCase();
  const skills = new Set();
  for (const [skill, words] of Object.entries(SKILL_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) skills.add(skill);
  }
  return [...skills];
}

async function getCurrentLoad(devs) {
  // Count open issues assigned to each dev
  const openIssues = await listIssues({ state: "open" });
  const realIssues = openIssues.filter((i) => !i.pull_request);
  const load = {};
  for (const dev of devs) load[dev] = 0;
  for (const issue of realIssues) {
    for (const a of issue.assignees || []) {
      if (load[a.login] !== undefined) load[a.login]++;
    }
  }
  return load;
}

export async function pickAssignee(issue) {
  const team = loadTeam();
  const devs = Object.keys(team);
  if (!devs.length) return { dev: null, reason: "No team configured" };

  const requiredSkills = detectSkills(issue);
  const load = await getCurrentLoad(devs);

  // Filter dev pool by skill match (or all if no skills detected)
  let candidates = devs.filter((d) => {
    if (!requiredSkills.length) return true;
    const skills = team[d].skills || [];
    return skills.some((s) => requiredSkills.includes(s));
  });

  // Filter out overloaded devs
  candidates = candidates.filter((d) => load[d] < (team[d].max_open || 999));

  // If skill match left no one (everyone overloaded or no skill match), fall back to all under cap
  if (!candidates.length) {
    candidates = devs.filter((d) => load[d] < (team[d].max_open || 999));
  }
  if (!candidates.length) {
    return { dev: null, reason: "All devs at max workload" };
  }

  // Pick least loaded; tie-break by alphabetical (deterministic)
  candidates.sort((a, b) => load[a] - load[b] || a.localeCompare(b));
  const dev = candidates[0];

  return {
    dev,
    reason: requiredSkills.length
      ? `Matched skills: ${requiredSkills.join(", ")}; current load ${load[dev]}/${team[dev].max_open}`
      : `No skills detected, picked least-loaded (${load[dev]} open)`,
    skills: requiredSkills,
    load: load[dev],
  };
}

export async function assignAndAnnounce(issue) {
  const result = await pickAssignee(issue);
  if (!result.dev) {
    return { ok: false, reason: result.reason };
  }
  // Skip if already assigned
  if ((issue.assignees || []).some((a) => a.login === result.dev)) {
    return { ok: false, reason: `Already assigned to ${result.dev}` };
  }
  await assignIssue(issue, [result.dev]);
  await commentIssue(
    issue,
    `🤖 **Auto-assigned to @${result.dev}**\n\n_${result.reason}_\n\n_PM Command Center · auto-assignment_`
  );
  return { ok: true, ...result };
}
