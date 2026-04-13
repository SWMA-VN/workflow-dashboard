// GitHub API helpers — used by all api/* routes.
// Token comes from env (server-side), never exposed to browser.

const GH_API = "https://api.github.com";

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pm-command-center",
  };
}

async function ghGet(path, params = {}) {
  const url = new URL(`${GH_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghPost(path, body) {
  const r = await fetch(`${GH_API}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghPatch(path, body) {
  const r = await fetch(`${GH_API}${path}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function listIssues({ state = "open", since } = {}) {
  const repo = process.env.GITHUB_REPO;
  const params = { state, per_page: 100 };
  if (since) params.since = since;
  return ghGet(`/repos/${repo}/issues`, params);
}

export async function listPulls({ state = "all", days = 30 } = {}) {
  const repo = process.env.GITHUB_REPO;
  const pulls = await ghGet(`/repos/${repo}/pulls`, {
    state,
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  if (!days) return pulls;
  const cutoff = Date.now() - days * 86400000;
  return pulls.filter((p) => new Date(p.updated_at).getTime() > cutoff);
}

export async function listCommits({ days = 7 } = {}) {
  const repo = process.env.GITHUB_REPO;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return ghGet(`/repos/${repo}/commits`, { since, per_page: 100 });
}

export async function getMetrics({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const allIssues = await listIssues({ state: "all", since });
  const realIssues = allIssues.filter((i) => !i.pull_request);
  const pulls = await listPulls({ state: "all", days });
  const commits = await listCommits({ days });

  const cutoff = Date.now() - days * 86400000;
  const opened = realIssues.filter((i) => new Date(i.created_at) >= cutoff);
  const closed = realIssues.filter((i) => i.closed_at && new Date(i.closed_at) >= cutoff);
  const prsOpened = pulls.filter((p) => new Date(p.created_at) >= cutoff);
  const prsMerged = pulls.filter((p) => p.merged_at && new Date(p.merged_at) >= cutoff);
  const prsOpen = pulls.filter((p) => p.state === "open");
  const inProgress = realIssues.filter((i) => i.state === "open" && i.assignees.length > 0);
  const blocked = realIssues.filter((i) => (i.labels || []).some((l) => /block/i.test(l.name)));

  const byPerson = {};
  const bump = (login, key) => {
    if (!byPerson[login]) byPerson[login] = { commits: 0, prs: 0, issues: 0 };
    byPerson[login][key]++;
  };
  for (const c of commits) bump(c.author?.login || c.commit.author.name, "commits");
  for (const p of prsOpened) bump(p.user.login, "prs");
  for (const i of inProgress) for (const a of i.assignees) bump(a.login, "issues");

  return {
    issues_opened: opened,
    issues_closed: closed,
    prs_opened: prsOpened,
    prs_merged: prsMerged,
    prs_open: prsOpen,
    in_progress: inProgress,
    blocked,
    commits,
    by_person: byPerson,
  };
}

export async function assignIssue(issueNumber, assignees) {
  const repo = process.env.GITHUB_REPO;
  return ghPost(`/repos/${repo}/issues/${issueNumber}/assignees`, { assignees });
}

export async function commentIssue(issueNumber, body) {
  const repo = process.env.GITHUB_REPO;
  return ghPost(`/repos/${repo}/issues/${issueNumber}/comments`, { body });
}

export async function addLabels(issueNumber, labels) {
  const repo = process.env.GITHUB_REPO;
  return ghPost(`/repos/${repo}/issues/${issueNumber}/labels`, { labels });
}
