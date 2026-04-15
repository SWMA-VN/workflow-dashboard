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
  frontend: ["frontend", "ui", "ux", "react", "vue", "css", "html", "tailwind", "form", "client-side", "loading animation", "animation", "landing page", "component"],
  backend: ["backend", "server", "database", "db", "sql", "node.js", "python", "express", "endpoint", "webhook", "sync", "synchronization", "real-time", "server-side", "queue", "cron", "migration"],
  mobile: ["ios app", "android app", "react-native", "react native", "flutter", "swift", "kotlin", "mobile app", "mobile ui", "native app"],
  payment: ["hitpay", "wechat pay", "fps", "stripe", "checkout flow", "payment flow"],
  qa: ["qa", "test-case", "tc-", "e2e test", "unit test", "regression", "test suite"],
  devops: ["devops", "ci/cd", "deploy", "vercel", "github-actions", "docker", "pipeline", "kubernetes", "infra"],
  integration: ["bydesign", "webhook", "integration", "third-party", "medusa", "sylius"],
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
  // PRIORITY 1: Trust AI-applied skill labels. If any skill label exists, use only those.
  const skillNames = Object.keys(SKILL_KEYWORDS);
  const labelSkills = (issue.labels || [])
    .map((l) => l.name.toLowerCase())
    .filter((n) => skillNames.includes(n));
  if (labelSkills.length) return [...new Set(labelSkills)];

  // PRIORITY 2: Fallback — scan text for keywords.
  const text = `${issue.title} ${issue.body || ""}`.toLowerCase();

  // Negation rules: "mobile API" / "API for mobile" is BACKEND, not mobile
  const isBackendMobile = /mobile\s+(api|apis|endpoint|endpoints|server)/i.test(text) ||
                          /api[s]?\s+for\s+mobile/i.test(text);

  const skills = new Set();
  for (const [skill, words] of Object.entries(SKILL_KEYWORDS)) {
    if (skill === "mobile" && isBackendMobile) continue; // skip mobile if it's actually backend
    if (words.some((w) => text.includes(w))) skills.add(skill);
  }
  if (isBackendMobile) skills.add("backend");
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
    `**Auto-assigned to @${result.dev}**\n\n_${result.reason}_\n\nBranch name: \`${issue.number}-your-description\`\nWhen you open a PR from this branch, the issue auto-moves to **In Review**.\nWhen PR is merged → **Testing**. When you close this issue → **Done**.`
  );
  return { ok: true, ...result };
}
