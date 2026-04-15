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

// Mode detection: if GITHUB_ORG is set, fetch org-wide via search API.
// Otherwise use single-repo mode via GITHUB_REPO.
export function scope() {
  const org = process.env.GITHUB_ORG;
  const repo = process.env.GITHUB_REPO;
  if (org) return { mode: "org", org, label: org };
  return { mode: "repo", repo, label: repo };
}

// Search API: org-wide issues and PRs
async function searchAll(q) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghGet(`/search/issues`, { q, per_page: 100, page });
    out.push(...(r.items || []));
    if (!r.items || r.items.length < 100) break;
  }
  return out;
}

export async function listIssues({ state = "open", since } = {}) {
  const s = scope();
  if (s.mode === "org") {
    // Fetch from active repos directly (Search API can't access private repos)
    const repos = await getActiveRepos(s.org);
    const all = [];
    const fetches = repos.map(async (r) => {
      try {
        const params = { state, per_page: 50 };
        if (since) params.since = since;
        const issues = await ghGet(`/repos/${r}/issues`, params);
        for (const i of issues) {
          i._repo = r;
          if (!i.repository_url) i.repository_url = `https://api.github.com/repos/${r}`;
        }
        all.push(...issues);
      } catch (e) { /* skip repos with errors */ }
    });
    await Promise.all(fetches);
    return all;
  }
  const params = { state, per_page: 100 };
  if (since) params.since = since;
  return ghGet(`/repos/${s.repo}/issues`, params);
}

// Cache active repos for 5 min
let _activeReposCache = null;
let _activeReposCacheTime = 0;

async function getActiveRepos(org) {
  // Cache 10 min to reduce API calls
  if (_activeReposCache && Date.now() - _activeReposCacheTime < 600000) return _activeReposCache;
  try {
    const repos = await ghGet(`/orgs/${org}/repos`, { per_page: 100, sort: "updated", type: "all" });
    // Only repos updated in last 30 days
    const cutoff = Date.now() - 30 * 86400000;
    // Top 10 most active repos (limits API calls per refresh)
    _activeReposCache = repos
      .filter((r) => new Date(r.updated_at).getTime() > cutoff)
      .slice(0, 10)
      .map((r) => r.full_name);
    _activeReposCacheTime = Date.now();
    return _activeReposCache;
  } catch (e) {
    return _activeReposCache || [];
  }
}

export async function listPulls({ state = "all", days = 30 } = {}) {
  const s = scope();
  if (s.mode === "org") {
    const repos = await getActiveRepos(s.org);
    const all = [];
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    const fetches = repos.map(async (r) => {
      try {
        const pulls = await ghGet(`/repos/${r}/pulls`, { state, sort: "updated", direction: "desc", per_page: 30 });
        for (const p of pulls) {
          if (cutoff && new Date(p.updated_at).getTime() < cutoff) continue;
          p._repo = r;
          all.push(p);
        }
      } catch (e) { /* skip */ }
    });
    await Promise.all(fetches);
    return all;
  }
  const pulls = await ghGet(`/repos/${s.repo}/pulls`, {
    state, sort: "updated", direction: "desc", per_page: 100,
  });
  if (!days) return pulls;
  const cutoff = Date.now() - days * 86400000;
  return pulls.filter((p) => new Date(p.updated_at).getTime() > cutoff);
}

export async function listCommits({ days = 7 } = {}) {
  const s = scope();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  if (s.mode === "org") {
    // Search API supports commits but limited; loop through repos
    const repos = await ghGet(`/orgs/${s.org}/repos`, { per_page: 100, type: "all" });
    const all = [];
    for (const r of repos) {
      try {
        const cs = await ghGet(`/repos/${r.full_name}/commits`, { since, per_page: 30 });
        all.push(...cs.map((c) => ({ ...c, _repo: r.full_name })));
      } catch (e) {
        // skip empty/inaccessible repos
      }
    }
    return all;
  }
  return ghGet(`/repos/${s.repo}/commits`, { since, per_page: 100 });
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
  const blocked = realIssues.filter((i) => i.state === "open" && (i.labels || []).some((l) => /block/i.test(l.name)));

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

// Issue mutations need explicit repo. In org mode, derive from issue URL.
function repoFromIssue(issueOrNumber) {
  if (typeof issueOrNumber === "object" && issueOrNumber.repository_url) {
    // search API gives repository_url like https://api.github.com/repos/owner/name
    const m = issueOrNumber.repository_url.match(/repos\/(.+)$/);
    if (m) return m[1];
  }
  return process.env.GITHUB_REPO;
}

// List milestones across all active repos (or single repo)
export async function listMilestones() {
  const s = scope();
  if (s.mode === "org") {
    const repos = await getActiveRepos(s.org);
    const all = [];
    const fetches = repos.map(async (r) => {
      try {
        const mls = await ghGet(`/repos/${r}/milestones`, { state: "open", per_page: 50 });
        for (const m of mls) {
          m._repo = r;
          all.push(m);
        }
      } catch (e) { /* skip */ }
    });
    await Promise.all(fetches);
    return all;
  }
  return ghGet(`/repos/${s.repo}/milestones`, { state: "open", per_page: 50 });
}

export async function assignIssue(issueOrNumber, assignees) {
  const repo = repoFromIssue(issueOrNumber);
  const num = typeof issueOrNumber === "object" ? issueOrNumber.number : issueOrNumber;
  return ghPost(`/repos/${repo}/issues/${num}/assignees`, { assignees });
}

export async function commentIssue(issueOrNumber, body) {
  const repo = repoFromIssue(issueOrNumber);
  const num = typeof issueOrNumber === "object" ? issueOrNumber.number : issueOrNumber;
  return ghPost(`/repos/${repo}/issues/${num}/comments`, { body });
}

export async function addLabels(issueOrNumber, labels) {
  const repo = repoFromIssue(issueOrNumber);
  const num = typeof issueOrNumber === "object" ? issueOrNumber.number : issueOrNumber;
  return ghPost(`/repos/${repo}/issues/${num}/labels`, { labels });
}
