// PM Command Center — public dashboard.
// All data fetched via /api/* (server-side, secrets stay safe).

// No auto-polling — manual refresh only (prevents rate limits)
// Data loads on: page load, tab switch, filter change, Refresh click
let lastGithubData = null; // cache last successful response
let filterDays = parseInt(localStorage.getItem("filterDays")) || 7;
let filterFrom = localStorage.getItem("filterFrom") || "";
let filterTo = localStorage.getItem("filterTo") || "";

// ===== Theme toggle =====
const themeToggle = document.getElementById("theme-toggle");
themeToggle.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
});
// Sync if OS theme changes (user hasn't manually overridden)
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (!localStorage.getItem("theme")) {
    document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
  }
});

// ===== Helpers =====
async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) {
    const hrs = Math.floor(ms / 3600000);
    if (hrs < 1) {
      const mins = Math.floor(ms / 60000);
      return mins < 1 ? "just now" : `${mins}m ago`;
    }
    return `${hrs}h ago`;
  }
  return `${days}d ago`;
}

function avatar(login) {
  return escapeHtml(login.slice(0, 2).toUpperCase());
}

const COLUMNS = ["Todo", "In Progress", "In Review", "Blocked", "Done"];

// Extract repo name from issue URL
function repoFromUrl(url) {
  if (!url) return "";
  const parts = url.split("/");
  return parts.length >= 5 ? parts[4] : "";
}

// Detect priority from labels
function priorityFromLabels(labels) {
  if (labels.some((l) => l === "p0")) return "p0";
  if (labels.some((l) => l === "p1")) return "p1";
  if (labels.some((l) => l === "p2")) return "p2";
  return "";
}

// Store last kanban data for filtering
let _kanbanData = null;

// Build a single card element
function buildCard(issue, col) {
  const repo = repoFromUrl(issue.url);
  const prio = priorityFromLabels(issue.labels);
  const isBlocker = issue.labels.some((l) => l.toLowerCase().includes("block"));
  const isMerged = issue.labels.includes("merged");

  const card = document.createElement("div");
  card.className = "card" + (isBlocker ? " blocker" : "") + (isMerged ? " merged" : "");
  card.draggable = true;
  card.dataset.issue = issue.number;
  card.dataset.repo = repo;
  card.dataset.col = col;
  card.dataset.url = issue.url;
  card.dataset.title = issue.title;
  card.dataset.assignees = issue.assignees.join(",");
  card.dataset.labels = issue.labels.join(",");
  card.dataset.updated = issue.updated_at;

  const systemLabels = ["pull-request", "merged", "inbox", "inbox-history", "discord", "customer-feedback", "p0", "p1", "p2", "status:in-progress", "status:in-review", "status:testing", "block", "blocked"];
  const displayLabels = issue.labels
    .filter((l) => !systemLabels.includes(l.toLowerCase()))
    .slice(0, 2)
    .map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`)
    .join("");

  const assigneeHtml = issue.assignees
    .map((a) => `<span class="assignee" title="${escapeHtml(a)}">${avatar(a)}</span>`)
    .join("");

  const prioDot = prio ? `<span class="card-priority prio-${prio}" title="${prio.toUpperCase()}"></span>` : "";
  const repoBadge = repo && repo !== "workflow-dashboard" ? `<span class="card-repo">${escapeHtml(repo)}</span>` : "";

  // SLA timer: P0=24h, P1=3d, P2=7d
  let slaHtml = "";
  if (prio && col !== "Done" && issue.created_at) {
    const slaH = prio === "p0" ? 24 : prio === "p1" ? 72 : 168;
    const elapsed = (Date.now() - new Date(issue.created_at).getTime()) / 3600000;
    const rem = slaH - elapsed;
    if (rem < 0) slaHtml = `<span class="sla-tag sla-breached">${Math.round(-rem)}h over</span>`;
    else if (rem < slaH * 0.25) slaHtml = `<span class="sla-tag sla-urgent">${rem < 24 ? Math.round(rem) + "h" : Math.round(rem / 24) + "d"}</span>`;
  }

  card.innerHTML = `
    <div class="card-num">${prioDot}#${issue.number}${repoBadge}${slaHtml}</div>
    <div class="card-title">${escapeHtml(issue.title)}</div>
    <div class="card-meta">${assigneeHtml}${displayLabels}<span class="card-age">${ago(issue.updated_at)}</span></div>`;

  // Click → open side panel (not GitHub link)
  card.addEventListener("click", (e) => {
    e.preventDefault();
    openSidePanel(issue, col, repo);
  });

  // Drag start
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.setData("text/plain", JSON.stringify({ issue: issue.number, repo, col }));
    e.dataTransfer.effectAllowed = "move";
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  return card;
}

// Build a single column with cards
function buildColumn(col, items, fAssignee, fRepo, fSearch) {
  const colEl = document.createElement("div");
  colEl.className = "column";
  colEl.dataset.col = col;

  let visibleCount = 0;
  const cardEls = [];

  for (const issue of items) {
    const repo = repoFromUrl(issue.url);
    const matchA = !fAssignee || issue.assignees.includes(fAssignee);
    const matchR = !fRepo || repo === fRepo;
    const matchS = !fSearch || issue.title.toLowerCase().includes(fSearch) || `#${issue.number}`.includes(fSearch);
    const visible = matchA && matchR && matchS;

    const card = buildCard(issue, col);
    if (!visible) card.classList.add("filtered-out");
    else visibleCount++;
    cardEls.push(card);
  }

  colEl.innerHTML = `<div class="column-header"><span>${col}</span><span class="col-count">${visibleCount}</span></div>`;
  if (visibleCount === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--text-faint);font-size:11px;text-align:center;padding:20px 0;font-style:italic";
    empty.textContent = "—";
    colEl.appendChild(empty);
  }
  for (const c of cardEls) colEl.appendChild(c);

  // Drop zone
  colEl.addEventListener("dragover", (e) => { e.preventDefault(); colEl.classList.add("drag-over"); });
  colEl.addEventListener("dragleave", () => colEl.classList.remove("drag-over"));
  colEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    colEl.classList.remove("drag-over");
    try {
      const d = JSON.parse(e.dataTransfer.getData("text/plain"));
      if (d.col === col) return; // same column, no move
      const fullRepo = `${process.env?.GITHUB_ORG || "SWMA-VN"}/${d.repo}`;
      await moveCard(d.repo, d.issue, col);
    } catch (err) { console.error(err); }
  });

  return colEl;
}

function renderKanban(data) {
  _kanbanData = data;
  const root = document.getElementById("kanban");
  root.innerHTML = "";
  populateKanbanFilters(data);

  const fAssignee = document.getElementById("filter-assignee")?.value || "";
  const fRepo = document.getElementById("filter-repo")?.value || "";
  const fSearch = (document.getElementById("filter-search")?.value || "").toLowerCase();
  const groupBy = document.getElementById("filter-group")?.value || "";

  if (!groupBy) {
    // Default: flat 6-column kanban
    for (const col of COLUMNS) {
      root.appendChild(buildColumn(col, data.columns[col] || [], fAssignee, fRepo, fSearch));
    }
  } else {
    // Grouped view: flat list per group (not mini-kanban)
    const groups = {};
    for (const col of COLUMNS) {
      for (const issue of (data.columns[col] || [])) {
        const repo = repoFromUrl(issue.url);
        let key;
        if (groupBy === "repo") key = repo || "unknown";
        else if (groupBy === "assignee") key = issue.assignees[0] || "unassigned";
        else key = "all";
        if (!groups[key]) groups[key] = [];

        // Apply filters
        const matchA = !fAssignee || issue.assignees.includes(fAssignee);
        const matchR = !fRepo || repo === fRepo;
        const matchS = !fSearch || issue.title.toLowerCase().includes(fSearch) || `#${issue.number}`.includes(fSearch);
        if (matchA && matchR && matchS) {
          groups[key].push({ ...issue, _col: col, _repo: repo });
        }
      }
    }

    // Sort groups by card count descending
    const sortedKeys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
    for (const key of sortedKeys) {
      const items = groups[key];
      if (!items.length) continue;
      const groupEl = document.createElement("div");
      groupEl.className = "swimlane-group";
      groupEl.innerHTML = `<div class="swimlane-header">${escapeHtml(key)}<span class="swimlane-count">${items.length}</span></div>`;

      const listEl = document.createElement("div");
      listEl.className = "swimlane-list";

      for (const item of items) {
        const prio = priorityFromLabels(item.labels);
        const prioDot = prio ? `<span class="card-priority prio-${prio}"></span>` : "";
        const statusClass = item._col === "Done" ? "s-done" : item._col === "Blocked" ? "s-blocked" : item._col === "In Review" ? "s-review" : item._col === "In Progress" ? "s-progress" : "s-todo";
        const assigneeHtml = item.assignees.length ? item.assignees.map((a) => `<span class="assignee">${avatar(a)}</span>`).join("") : "";
        const repoBadge = item._repo && item._repo !== "workflow-dashboard" ? `<span class="card-repo">${escapeHtml(item._repo)}</span>` : "";

        const row = document.createElement("div");
        row.className = `swimlane-row ${statusClass}`;
        row.innerHTML = `
          <span class="sr-status">${item._col}</span>
          <span class="sr-num">${prioDot}#${item.number}</span>
          <span class="sr-title">${escapeHtml(item.title)}</span>
          <span class="sr-meta">${assigneeHtml}${repoBadge}<span class="card-age">${ago(item.updated_at)}</span></span>`;
        row.addEventListener("click", () => openSidePanel(item, item._col, item._repo));
        listEl.appendChild(row);
      }

      groupEl.appendChild(listEl);
      root.appendChild(groupEl);
    }
  }
}

// ===== SIDE PANEL =====
function openSidePanel(issue, col, repo) {
  const panel = document.getElementById("side-panel");
  panel.classList.remove("hidden");
  document.getElementById("sp-num").textContent = `#${issue.number}`;
  document.getElementById("sp-github-link").href = issue.url;
  document.getElementById("sp-title").textContent = issue.title;
  document.getElementById("sp-status").textContent = col;
  document.getElementById("sp-repo").textContent = repo;
  document.getElementById("sp-assignees").textContent = issue.assignees.join(", ") || "unassigned";
  document.getElementById("sp-priority").textContent = priorityFromLabels(issue.labels).toUpperCase() || "—";
  document.getElementById("sp-labels").textContent = issue.labels.filter((l) => !["pull-request","merged"].includes(l)).join(", ") || "—";
  document.getElementById("sp-updated").textContent = new Date(issue.updated_at).toLocaleString();

  // Load comments
  loadComments(issue, repo);

  // Highlight current column in move buttons
  document.querySelectorAll(".sp-move-btn").forEach((btn) => {
    btn.style.background = btn.dataset.col === col ? "var(--accent)" : "";
    btn.style.color = btn.dataset.col === col ? "#fff" : "";
    btn.onclick = async () => {
      if (btn.dataset.col === col) return;
      btn.textContent = "...";
      await moveCard(repo, issue.number, btn.dataset.col);
      panel.classList.add("hidden");
    };
  });
}

document.getElementById("sp-close")?.addEventListener("click", () => document.getElementById("side-panel").classList.add("hidden"));
document.getElementById("side-panel-overlay")?.addEventListener("click", () => document.getElementById("side-panel").classList.add("hidden"));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("side-panel")?.classList.add("hidden"); });

// ===== COMMENTS IN SIDE PANEL =====
let _currentIssueForComment = null;

function loadComments(issue, repo) {
  _currentIssueForComment = { number: issue.number, repo };
  const list = document.getElementById("sp-comments-list");
  if (!list) return;
  list.innerHTML = '<span style="font-size:11px;color:var(--text-faint)">Comments load from GitHub on send.</span>';
}

document.getElementById("sp-comment-send")?.addEventListener("click", async () => {
  const input = document.getElementById("sp-comment-input");
  const text = input?.value?.trim();
  if (!text || !_currentIssueForComment) return;

  const btn = document.getElementById("sp-comment-send");
  btn.disabled = true; btn.textContent = "...";

  try {
    const fullRepo = _currentIssueForComment.repo.includes("/") ? _currentIssueForComment.repo : `SWMA-VN/${_currentIssueForComment.repo}`;
    await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "comment", repo: fullRepo, issue: _currentIssueForComment.number, body: text }),
    });
    input.value = "";
    document.getElementById("sp-comments-list").innerHTML = `<div style="font-size:11px;color:var(--success);padding:4px 0">Comment posted.</div>`;
  } catch (e) {
    document.getElementById("sp-comments-list").innerHTML = `<div style="font-size:11px;color:var(--danger)">${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = "Send";
  }
});

document.getElementById("sp-comment-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sp-comment-send")?.click();
});

// ===== MOVE CARD (drag-drop + side panel) =====
async function moveCard(repo, issueNumber, targetColumn) {
  try {
    const fullRepo = repo.includes("/") ? repo : `SWMA-VN/${repo}`;
    const r = await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: fullRepo, issue: issueNumber, column: targetColumn }),
    });
    const d = await r.json();
    if (d.ok) {
      // Refresh kanban data
      loadGithub();
    }
  } catch (e) {
    console.error("Move failed:", e);
  }
}

function populateKanbanFilters(data) {
  const assigneeSelect = document.getElementById("filter-assignee");
  const repoSelect = document.getElementById("filter-repo");
  if (!assigneeSelect || !repoSelect) return;

  // Collect unique assignees + repos from all columns
  const assignees = new Set();
  const repos = new Set();
  for (const col of COLUMNS) {
    for (const issue of (data.columns[col] || [])) {
      issue.assignees.forEach((a) => assignees.add(a));
      const r = repoFromUrl(issue.url);
      if (r) repos.add(r);
    }
  }

  // Only repopulate if options changed
  const curAssignee = assigneeSelect.value;
  const curRepo = repoSelect.value;

  if (assigneeSelect.options.length !== assignees.size + 1) {
    assigneeSelect.innerHTML = '<option value="">All members</option>';
    [...assignees].sort().forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a; opt.textContent = a;
      assigneeSelect.appendChild(opt);
    });
    assigneeSelect.value = curAssignee;
  }

  if (repoSelect.options.length !== repos.size + 1) {
    repoSelect.innerHTML = '<option value="">All repos</option>';
    [...repos].sort().forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r; opt.textContent = r;
      repoSelect.appendChild(opt);
    });
    repoSelect.value = curRepo;
  }
}

function renderMetrics(data) {
  const m = data.metrics;
  document.getElementById("m-velocity").textContent = m.velocity_30d;
  document.getElementById("m-progress").textContent = m.in_progress;
  document.getElementById("m-review").textContent = m.in_review;
  document.getElementById("m-blocked").textContent = m.blocked;
  document.getElementById("m-merged").textContent = m.merged_30d;
  document.getElementById("m-commits").textContent = m.commits_30d;
}

function renderPeople(data) {
  const root = document.getElementById("people-grid");
  root.innerHTML = "";
  const sorted = Object.entries(data.by_person).sort((a, b) => b[1].commits - a[1].commits);
  if (!sorted.length) {
    root.innerHTML = '<div class="loading">No activity yet — pushes/PRs will show here.</div>';
    return;
  }
  for (const [login, s] of sorted) {
    const card = document.createElement("div");
    card.className = "person-card";
    card.innerHTML = `
      <div class="person-name"><span class="person-avatar">${avatar(login)}</span>${escapeHtml(login)}</div>
      <div class="person-stats">
        <div class="person-stat"><div class="person-stat-val">${s.commits}</div><div class="person-stat-label">Commits</div></div>
        <div class="person-stat"><div class="person-stat-val">${s.prs}</div><div class="person-stat-label">PRs</div></div>
        <div class="person-stat"><div class="person-stat-val">${s.issues}</div><div class="person-stat-label">Open</div></div>
      </div>`;
    root.appendChild(card);
  }
}

async function loadGithub() {
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.classList.add("spinning");
  document.getElementById("last-updated").textContent = "loading...";
  try {
    let data;
    try {
      const fq = filterFrom && filterTo ? `from=${filterFrom}&to=${filterTo}` : `days=${filterDays}`;
      data = await fetchJson(`/api/github?${fq}`);
      if (data.error) throw new Error(data.error);
      lastGithubData = data; // cache on success
    } catch (fetchErr) {
      // On ANY error: show last cached data if available
      if (lastGithubData) {
        data = lastGithubData;
        document.getElementById("last-updated").textContent = `cached · ${new Date().toLocaleTimeString()}`;
        setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
        renderKanban(data);
        renderMetrics(data);
        renderPeople(data);
        return;
      }
      throw fetchErr;
    }
    document.getElementById("repo-name").textContent = data.repo;
    document.getElementById("repo-link").href = `https://github.com/${data.repo}`;
    renderKanban(data);
    renderMetrics(data);
    renderPeople(data);
    // Show filter info
    const info = document.getElementById("filter-info");
    if (info) {
      if (data.filter_from && data.filter_to) {
        info.textContent = `Showing: ${data.filter_from} to ${data.filter_to} · Done: ${data.columns?.Done?.length || 0} closed issues`;
      } else if (data.filter_days === 0) {
        info.textContent = `Showing: all time · Done: ${data.columns?.Done?.length || 0} closed issues`;
      } else {
        info.textContent = `Showing: last ${data.filter_days} days · Done: ${data.columns?.Done?.length || 0} closed issues`;
      }
    }
    document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById("last-updated").textContent = "click Refresh to retry";
    document.getElementById("last-updated").textContent = "click Refresh to retry";
    // Never show error on Kanban — leave whatever was there, or show minimal message
    if (!document.getElementById("kanban").children.length || document.getElementById("kanban").querySelector(".loading")) {
      document.getElementById("kanban").innerHTML = `<div class="loading">Could not load data. Click Refresh to try again.</div>`;
    }
  } finally {
    setTimeout(() => refreshBtn.classList.remove("spinning"), 400);
  }
}

async function loadSheets() {
  const wrap = document.getElementById("sheets-table-wrap");
  document.getElementById("sheets-source").textContent = "fetching…";
  try {
    const data = await fetchJson("/api/sheets");
    document.getElementById("sheets-source").textContent = data.source;
    if (data.error) {
      wrap.innerHTML = `<div class="loading">⚠️ ${escapeHtml(data.error)}<br><br>See <code>docs/03_setup_google_sheets.md</code> to publish your sheet.</div>`;
      return;
    }
    if (!data.rows.length) {
      wrap.innerHTML = `<div class="loading">No rows in sheet.</div>`;
      return;
    }
    const cols = Object.keys(data.rows[0]);
    let html = '<table class="sheets-table"><thead><tr>';
    for (const c of cols) html += `<th>${escapeHtml(c)}</th>`;
    html += "</tr></thead><tbody>";
    for (const row of data.rows.slice(0, 100)) {
      html += "<tr>";
      for (const c of cols) html += `<td>${escapeHtml(row[c])}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    if (data.rows.length > 100) html += `<p class="hint" style="margin-top:10px">Showing first 100 of ${data.rows.length} rows.</p>`;
    wrap.innerHTML = html;
  } catch (e) {
    wrap.innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

// loadDiscord removed — tab deleted

async function loadAssign() {
  try {
    const r = await fetch("/api/config?type=team-info");
    if (r.ok) {
      const data = await r.json();
      document.getElementById("team-config").textContent = JSON.stringify(data.team, null, 2);
    }
  } catch (e) {
    document.getElementById("team-config").textContent = "Could not load team config";
  }
}

// ======= INBOX TAB =======
document.querySelectorAll(".inbox-type-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".inbox-type-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const t = btn.dataset.type;
    document.getElementById("inbox-text-input").style.display = t === "text" ? "" : "none";
    document.getElementById("inbox-url-input").style.display = t === "url" ? "" : "none";
  });
});

document.getElementById("inbox-submit").addEventListener("click", async () => {
  const title = document.getElementById("inbox-title").value.trim() || "Untitled";
  const activeType = document.querySelector(".inbox-type-btn.active").dataset.type;
  const content = activeType === "text" ? document.getElementById("inbox-content").value.trim() : "";
  const url = activeType === "url" ? document.getElementById("inbox-url").value.trim() : "";

  if (!content && !url) { alert("Paste content or a URL first."); return; }

  const resultDiv = document.getElementById("inbox-result");
  const resultTitle = document.getElementById("inbox-result-title");
  const resultBody = document.getElementById("inbox-result-body");
  resultDiv.style.display = "";
  resultTitle.textContent = "Processing… (AI extracting action items)";
  resultBody.innerHTML = '<div class="loading">This may take 10-30 seconds depending on document size.</div>';

  const submitBtn = document.getElementById("inbox-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Processing…";

  try {
    const r = await fetch("/api/inbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: activeType, content, url, title }),
    });
    const data = await r.json();

    if (!r.ok) {
      resultTitle.textContent = "Error";
      resultBody.innerHTML = `<pre class="result-pane">${escapeHtml(data.error || JSON.stringify(data))}</pre>`;
      return;
    }

    if (data.issues_created === 0) {
      resultTitle.textContent = "No actionable items found";
      resultBody.innerHTML = `<p>AI could not extract tasks from this content. Try pasting with clearer bullet points or numbered action items.</p>`;
      return;
    }

    resultTitle.textContent = `✅ ${data.issues_created} issues created from "${escapeHtml(title)}"`;
    const issueHtml = (data.issues || [])
      .filter((i) => i.number)
      .map((i) => `
        <a href="${i.url}" target="_blank" class="inbox-issue-card">
          <span class="inbox-issue-num">#${i.number}</span>
          <span class="inbox-issue-title">${escapeHtml(i.title)}</span>
          <span class="inbox-issue-labels">${(i.labels || []).map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`).join(" ")}</span>
        </a>`)
      .join("");

    resultBody.innerHTML = `
      <p class="hint">Method: ${data.ai_used ? "AI extraction" : "Basic extraction (no AI key — add Gemini key for better results)"}. Auto-assign fires within 5 sec for each issue.</p>
      <div class="inbox-issues-list">${issueHtml}</div>`;

    // Refresh dashboard data after a delay (let webhooks fire)
    setTimeout(() => { loadGithub(); loadInboxHistory(); }, 5000);
  } catch (e) {
    resultTitle.textContent = "Error";
    resultBody.innerHTML = `<pre class="result-pane">${escapeHtml(e.message)}</pre>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "📥 Process & Create Issues";
  }
});

// ======= INBOX HISTORY =======
async function loadInboxHistory() {
  const wrap = document.getElementById("inbox-history-list");
  try {
    const data = await fetchJson("/api/inbox");
    if (!data.history || !data.history.length) {
      wrap.innerHTML = '<div class="loading">No submissions yet. Use the form above to process your first document.</div>';
      return;
    }
    wrap.innerHTML = data.history.map((h) => {
      const typeIcon = { "google-sheet": "📊", "google-doc": "📄", "pasted-text": "📝", "url": "🔗" }[h.doc_type] || "📎";
      const date = new Date(h.submitted_at).toLocaleDateString("en-CA") + " " + new Date(h.submitted_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const taskLinks = (h.tasks || []).map((t) =>
        `<a href="${t.url}" target="_blank" class="hist-task-link">#${t.number}</a>`
      ).join(" ");

      return `
        <a href="${h.log_url}" target="_blank" class="hist-row">
          <span class="hist-icon">${typeIcon}</span>
          <div class="hist-main">
            <div class="hist-title">${escapeHtml(h.document_title)}</div>
            <div class="hist-meta">${date} · ${h.doc_type} · AI: ${h.ai_used} · ${h.issues_created} tasks created</div>
            <div class="hist-tasks">${taskLinks || '<span class="hint">no tasks</span>'}</div>
          </div>
          <span class="hist-count">${h.issues_created}</span>
        </a>`;
    }).join("");
  } catch (e) {
    wrap.innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("dry-btn").addEventListener("click", async () => {
  const num = document.getElementById("dry-issue").value;
  if (!num) return;
  const out = document.getElementById("dry-result");
  out.textContent = "Picking…";
  try {
    const r = await fetch(`/api/assign?issue=${num}&dry=1`, { method: "POST" });
    out.textContent = JSON.stringify(await r.json(), null, 2);
  } catch (e) { out.textContent = `Error: ${e.message}`; }
});

document.getElementById("real-btn").addEventListener("click", async () => {
  const num = document.getElementById("real-issue").value;
  if (!num) return;
  if (!confirm(`Assign issue #${num} for real?`)) return;
  const out = document.getElementById("real-result");
  out.textContent = "Assigning…";
  try {
    const r = await fetch(`/api/assign?issue=${num}`, { method: "POST" });
    out.textContent = JSON.stringify(await r.json(), null, 2);
  } catch (e) { out.textContent = `Error: ${e.message}`; }
});

// ======= OVERVIEW TAB =======
// Single fetch for overview — eliminates 3 duplicate API calls
async function loadOverview() {
  const filterQuery = filterFrom && filterTo ? `from=${filterFrom}&to=${filterTo}` : `days=${filterDays}`;
  try {
    const data = await fetchJson(`/api/github?${filterQuery}`);
    if (data && !data.error) {
      renderCapacity(data);
      renderHealthScore(data);
      renderMilestonesList(data);
    }
  } catch (e) {}
  await Promise.all([loadWip(), loadVelocity(), loadStale()]);
}

function renderCapacity(data) {
  try {
    const c = data?.capacity;
    if (!c) return;
    document.getElementById("capacity-rec").textContent = c.recommendation;
    const wrap = document.getElementById("capacity-bars");
    if (!wrap) return;
    wrap.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:8px">
        <div class="wip-stat"><span class="wip-stat-val">${c.committed}</span><span class="wip-stat-label">Committed</span></div>
        <div class="wip-stat"><span class="wip-stat-val">${c.total_slots}</span><span class="wip-stat-label">Capacity</span></div>
        <div class="wip-stat"><span class="wip-stat-val" style="color:${c.overloaded ? 'var(--danger)' : 'var(--success)'}">${c.available}</span><span class="wip-stat-label">Available</span></div>
        <div class="wip-stat"><span class="wip-stat-val">${c.utilization_pct}%</span><span class="wip-stat-label">Util</span></div>
      </div>
      ${c.per_dev.map((d) => {
        const pct = d.max ? Math.min(100, Math.round((d.open / d.max) * 100)) : 0;
        const color = d.overloaded ? "var(--danger)" : pct > 66 ? "var(--warning)" : "var(--success)";
        return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:11px">
          <span style="width:100px;font-weight:500">${escapeHtml(d.login)}</span>
          <div style="flex:1;height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${color};border-radius:2px"></div></div>
          <span style="font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text-faint);min-width:35px;text-align:right">${d.open}/${d.max}</span>
        </div>`;
      }).join("")}`;
  } catch (e) {}
}

function renderHealthScore(data) {
  try {
    const h = data?.health;
    if (!h) return;

    // Score number + ring
    const ring = document.getElementById("health-ring");
    const scoreEl = document.getElementById("health-score");
    if (ring && scoreEl) {
      scoreEl.textContent = h.score;
      ring.className = `health-score-ring grade-${h.grade}`;
    }

    // Factor bars
    const wrap = document.getElementById("health-factors");
    if (wrap && h.factors) {
      wrap.innerHTML = h.factors.map((f) => {
        const pct = Math.round((f.score / f.max) * 100);
        const cls = pct >= 75 ? "hf-good" : pct >= 50 ? "hf-ok" : pct >= 25 ? "hf-warn" : "hf-bad";
        return `<div class="health-factor">
          <span class="hf-name">${f.name}</span>
          <div class="hf-bar"><div class="hf-bar-fill ${cls}" style="width:${pct}%"></div></div>
          <span class="hf-score">${f.score}/${f.max}</span>
        </div>`;
      }).join("");
    }
  } catch (e) {}
}

// ===== SPRINT PLANNER =====
document.getElementById("plan-sprint-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("plan-sprint-btn");
  const result = document.getElementById("sprint-plan-result");
  btn.disabled = true;
  btn.textContent = "Planning...";
  result.innerHTML = '<div class="loading">AI analyzing backlog + team capacity...</div>';

  try {
    const r = await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "plan-sprint" }),
    });
    const d = await r.json();
    if (!d.ok || !d.sprint_plan?.length) {
      result.innerHTML = '<div class="loading">No suggestions. Add more issues to backlog or check AI key.</div>';
      return;
    }
    result.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Suggested ${d.sprint_plan.length} issues from ${d.backlog_size} backlog items</div>
      ${d.sprint_plan.map((p) => `
        <div class="swimlane-row s-todo" style="cursor:default">
          <span class="sr-status">${p.prio?.toUpperCase() || "P1"}</span>
          <span class="sr-num">#${p.number}</span>
          <span class="sr-title">${escapeHtml(p.title || "")}</span>
          <span class="sr-meta"><span class="card-repo">${escapeHtml(p.repo || "")}</span></span>
        </div>`).join("")}
      <div style="font-size:10px;color:var(--text-faint);margin-top:8px">Click issues in GitHub to assign to a milestone for tracking.</div>`;
  } catch (e) {
    result.innerHTML = `<div class="loading">${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Plan Next Sprint";
  }
});

// ===== BURNDOWN =====
function renderBurndown(data) {
  const wrap = document.getElementById("burndown-chart");
  if (!wrap) return;
  const bd = (data || []).filter((m) => m.total > 0);
  if (!bd.length) {
    wrap.innerHTML = '<div class="loading">Assign issues to milestones to see burndown.</div>';
    return;
  }
  wrap.innerHTML = bd.map((m) => {
    const pct = m.percent;
    const remaining = m.remaining;
    const barColor = pct >= 80 ? "var(--success)" : pct >= 40 ? "var(--accent)" : "var(--warning)";
    return `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:12px;font-weight:600;color:var(--text)">${escapeHtml(m.title)}</span>
          <span style="font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${m.closed}/${m.total} done · ${remaining} left · ${pct}%</span>
        </div>
        <div style="height:10px;background:var(--bg-elevated);border-radius:5px;overflow:hidden">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:5px;transition:width 0.4s"></div>
        </div>
        ${m.due_on ? `<div style="font-size:9px;color:var(--text-faint);margin-top:2px">Target: ${new Date(m.due_on).toISOString().slice(0, 10)}</div>` : ""}
      </div>`;
  }).join("");
}

// ===== NL SEARCH =====
document.getElementById("filter-search")?.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const query = e.target.value.trim();
  if (!query || query.length < 8) return; // short = normal text filter
  // Check if it looks like natural language
  const nlWords = ["show", "find", "list", "get", "what", "who", "which", "all", "from", "last", "this", "bugs", "issues"];
  const isNL = nlWords.some((w) => query.toLowerCase().includes(w));
  if (!isNL) return;

  e.target.style.borderColor = "var(--accent)";
  try {
    const data = await fetchJson(`/api/github?days=0&nlq=${encodeURIComponent(query)}`);
    if (data.nl_search) {
      const ns = data.nl_search;
      if (ns.assignee) document.getElementById("filter-assignee").value = ns.assignee;
      if (ns.repo) document.getElementById("filter-repo").value = ns.repo;
      if (ns.text) document.getElementById("filter-search").value = ns.text;
      if (_kanbanData) renderKanban(_kanbanData);
    }
  } catch (err) {}
  e.target.style.borderColor = "";
});

async function loadRoadmap() {
  const wrap = document.getElementById("roadmap-timeline");
  if (!wrap) return;
  try {
    const data = await fetchJson(`/api/github?days=0`);
    const ms = (data.milestones || []).filter((m) => m.due_on);
    if (!ms.length) {
      wrap.innerHTML = '<div class="loading">No milestones with due dates. Add due dates to milestones in GitHub.</div>';
      return;
    }

    // Calculate timeline range
    const now = Date.now();
    const dates = ms.flatMap((m) => [new Date(m.due_on).getTime(), m.forecast ? new Date(m.forecast).getTime() : 0]).filter(Boolean);
    const earliest = Math.min(now - 14 * 86400000, ...dates);
    const latest = Math.max(now + 30 * 86400000, ...dates) + 14 * 86400000;
    const range = latest - earliest;
    const pct = (t) => Math.max(0, Math.min(100, ((t - earliest) / range) * 100));

    // Now marker
    const nowPct = pct(now);

    let html = '<div class="roadmap-container">';

    // Milestone bars
    for (const m of ms) {
      const targetMs = new Date(m.due_on).getTime();
      const forecastMs = m.forecast ? new Date(m.forecast).getTime() : targetMs;
      const startPct = Math.max(0, pct(Math.min(now - 30 * 86400000, targetMs - 60 * 86400000)));
      const endPct = pct(Math.max(targetMs, forecastMs));
      const barWidth = Math.max(8, endPct - startPct);
      const targetDate = new Date(m.due_on).toISOString().slice(5, 10);
      const repoShort = (m.repo || "").split("/").pop();

      html += `
        <div class="roadmap-item">
          <div class="rm-label">
            <div class="rm-name">${escapeHtml(m.title)}</div>
            <div class="rm-repo">${escapeHtml(repoShort)}</div>
          </div>
          <div class="rm-bar-wrap">
            <div class="rm-bar status-${m.status}" style="left:${startPct}%;width:${barWidth}%">
              <div class="rm-progress" style="width:${m.percent}%"></div>
              <div class="rm-info">
                <span class="rm-pct">${m.percent}%</span>
                <span class="rm-date">${targetDate}</span>
                <span class="rm-status-tag">${m.status.replace("-", " ")}</span>
              </div>
            </div>
          </div>
        </div>`;
    }

    // Axis with now marker
    html += `
      <div style="position:relative;margin:8px 0 0 140px;height:20px">
        <div style="position:absolute;left:${nowPct}%;top:0;width:1px;height:16px;background:var(--danger)"></div>
        <div style="position:absolute;left:${nowPct}%;top:16px;font-size:9px;color:var(--danger);transform:translateX(-50%);font-weight:600">Today</div>
      </div>`;

    html += '</div>';
    wrap.innerHTML = html;
  } catch (e) {
    wrap.innerHTML = '<div class="loading">Click Refresh to retry</div>';
  }
}

function renderMilestonesList(data) {
  const wrap = document.getElementById("milestones-list");
  if (!wrap) return;
  try {
    const ms = data.milestones || [];
    if (!ms.length) {
      wrap.innerHTML = '<div class="loading">No open milestones. Create one in GitHub: any repo → Issues → Milestones → New milestone.</div>';
      return;
    }
    wrap.innerHTML = ms.map((m) => {
      const pct = Math.min(m.percent, 100);
      const forecastDate = m.forecast ? new Date(m.forecast).toISOString().slice(0, 10) : null;
      const targetDate = m.due_on ? new Date(m.due_on).toISOString().slice(0, 10) : null;
      const offsetLabel = m.days_offset > 0 ? `+${m.days_offset}d late` : m.days_offset < 0 ? `${Math.abs(m.days_offset)}d ahead` : "on target";
      const repoName = (m.repo || "").split("/").pop();
      const risk = m.risk || {};
      const riskHtml = risk.factors?.length ? `<span class="sla-tag ${risk.level === 'high' ? 'sla-breached' : risk.level === 'medium' ? 'sla-urgent' : ''}" title="${(risk.factors||[]).join(', ')}">${risk.level} risk</span>` : "";
      return `
        <a href="${m.url}" target="_blank" class="milestone-row status-${m.status}">
          <div>
            <div class="milestone-title">${escapeHtml(m.title)} ${riskHtml}</div>
            <div class="milestone-meta">
              ${m.closed}/${m.total} tasks · ${escapeHtml(repoName)}
              ${targetDate ? ` · target: ${targetDate}` : ""}
              ${forecastDate ? ` · forecast: ${forecastDate} (${offsetLabel})` : ""}
              ${risk.factors?.length ? ` · ${risk.factors[0]}` : ""}
            </div>
            <div class="milestone-bar"><div class="milestone-bar-fill" style="width:${pct}%"></div></div>
          </div>
          <div class="milestone-side">
            <span class="milestone-percent">${pct}%</span>
            <span class="milestone-status-badge">${m.status.replace("-", " ")}</span>
          </div>
        </a>`;
    }).join("");
  } catch (e) {
    wrap.innerHTML = '<div class="loading">Click Refresh to retry</div>';
  }
}

async function loadWip() {
  try {
    const data = await fetchJson("/api/wip");
    document.getElementById("wip-team-load").textContent = data.team_wip;
    document.getElementById("wip-team-cap").textContent = data.team_capacity;
    document.getElementById("wip-team-pct").textContent = `${data.team_percent}%`;
    document.getElementById("wip-unassigned").textContent = data.unassigned_open;

    const list = document.getElementById("wip-list");
    if (!data.devs.length) {
      list.innerHTML = '<div class="loading">No team configured. Set TEAM_CONFIG env var.</div>';
      return;
    }
    list.innerHTML = data.devs.map((d) => {
      const pct = Math.min(d.percent, 100);
      const stale = d.stale_count > 0 ? `<span class="wip-stale" title="${d.stale_count} stale">⏰ ${d.stale_count}</span>` : "";
      const issues = d.issues.slice(0, 3).map((i) =>
        `<a href="${i.url}" target="_blank" class="wip-issue" title="${escapeHtml(i.title)}">#${i.number}</a>`
      ).join("");
      const more = d.issues.length > 3 ? `<span class="wip-issue-more">+${d.issues.length - 3}</span>` : "";
      return `
        <div class="wip-dev wip-${d.status}">
          <div class="wip-dev-head">
            <span class="person-avatar">${avatar(d.login)}</span>
            <span class="wip-dev-name">${escapeHtml(d.login)}</span>
            <span class="wip-skills">${(d.skills || []).map((s) => `<code>${s}</code>`).join(" ")}</span>
            ${stale}
            <span class="wip-count">${d.open_count} / ${d.max_open}</span>
          </div>
          <div class="wip-bar"><div class="wip-bar-fill wip-bar-${d.status}" style="width: ${pct}%"></div></div>
          <div class="wip-issues">${issues}${more}</div>
        </div>`;
    }).join("");
  } catch (e) {
    document.getElementById("wip-list").innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

async function loadVelocity() {
  try {
    const data = await fetchJson("/api/performance");
    const weeks = data.velocity_sparkline || [];
    const max = Math.max(1, ...weeks.map((w) => w.merged));
    const wrap = document.getElementById("velocity-bars");
    wrap.innerHTML = `
      <div class="vel-row">
        ${weeks.map((w, i) => {
          const labels = ["3 weeks ago", "2 weeks ago", "Last week", "This week"];
          const h = (w.merged / max) * 100;
          return `<div class="vel-col">
            <div class="vel-val">${w.merged}</div>
            <div class="vel-bar"><div class="vel-bar-fill" style="height:${h}%"></div></div>
            <div class="vel-label">${labels[i]}</div>
          </div>`;
        }).join("")}
      </div>`;
  } catch (e) {
    document.getElementById("velocity-bars").innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

async function loadStale() {
  try {
    const data = await fetchJson("/api/performance");
    const stale = data.stale_tickets || [];
    const list = document.getElementById("stale-list");
    if (!stale.length) {
      list.innerHTML = '<div class="loading">✅ No stale tickets — everything moving!</div>';
      return;
    }
    list.innerHTML = stale.map((s) => {
      const assignees = s.assignees.length
        ? s.assignees.map((a) => `<span class="assignee">${avatar(a)}</span>`).join("")
        : '<span class="label-tag">unassigned</span>';
      const sev = s.days_stale >= 7 ? "danger" : s.days_stale >= 5 ? "warning" : "muted";
      return `
        <a href="${s.url}" target="_blank" class="stale-row stale-${sev}">
          <span class="stale-days">${s.days_stale}d</span>
          <span class="stale-num">#${s.number}</span>
          <span class="stale-title">${escapeHtml(s.title)}</span>
          <span class="stale-assignees">${assignees}</span>
        </a>`;
    }).join("");
  } catch (e) {
    document.getElementById("stale-list").innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

// ======= PERFORMANCE TAB =======
async function loadPerformance() {
  try {
    const data = await fetchJson("/api/performance");

    // Cycle time
    const ct = data.cycle_time_days;
    const cs = document.getElementById("cycle-stats");
    if (ct.sample_size === 0) {
      cs.innerHTML = '<div class="loading">No merged PRs yet. Cycle time will appear after first PR merges.</div>';
    } else {
      const healthClass = ct.health === "good" ? "success" : ct.health === "ok" ? "warning" : "danger";
      cs.innerHTML = `
        <div class="cycle-grid">
          <div class="cycle-stat">
            <div class="cycle-val">${ct.p50 ?? "—"}<span class="cycle-unit">d</span></div>
            <div class="cycle-label">P50 (median)</div>
          </div>
          <div class="cycle-stat">
            <div class="cycle-val">${ct.p90 ?? "—"}<span class="cycle-unit">d</span></div>
            <div class="cycle-label">P90 (worst case)</div>
          </div>
          <div class="cycle-stat">
            <div class="cycle-val">${ct.mean ?? "—"}<span class="cycle-unit">d</span></div>
            <div class="cycle-label">Average</div>
          </div>
          <div class="cycle-stat">
            <div class="cycle-val cycle-${healthClass}">${ct.health.toUpperCase()}</div>
            <div class="cycle-label">Sample: ${ct.sample_size} PRs (last 60d)</div>
          </div>
        </div>`;
    }

    // Quality
    const q = data.quality;
    const qHealth = q.health === "good" ? "success" : q.health === "ok" ? "warning" : "danger";
    document.getElementById("quality-stats").innerHTML = `
      <div class="cycle-grid">
        <div class="cycle-stat">
          <div class="cycle-val">${q.bugs_30d}</div>
          <div class="cycle-label">Bugs filed (30d)</div>
        </div>
        <div class="cycle-stat">
          <div class="cycle-val">${q.merged_30d}</div>
          <div class="cycle-label">PRs merged (30d)</div>
        </div>
        <div class="cycle-stat">
          <div class="cycle-val cycle-${qHealth}">${q.bug_rate_percent}%</div>
          <div class="cycle-label">Bug rate · ${q.health.toUpperCase()}</div>
        </div>
      </div>`;

    // Throughput per dev
    const tp = data.throughput_per_dev || [];
    const tpWrap = document.getElementById("throughput-list");
    if (!tp.length) {
      tpWrap.innerHTML = '<div class="loading">No PRs merged in last 30 days yet.</div>';
    } else {
      const max = Math.max(1, ...tp.map((t) => t.prs_merged));
      tpWrap.innerHTML = tp.map((t) => {
        const w = (t.prs_merged / max) * 100;
        return `
          <div class="tp-row">
            <span class="person-avatar">${avatar(t.login)}</span>
            <span class="tp-name">${escapeHtml(t.login)}</span>
            <div class="tp-bar-wrap"><div class="tp-bar" style="width:${w}%"></div></div>
            <span class="tp-val">${t.prs_merged} PRs · ${t.avg_cycle_days}d avg</span>
          </div>`;
      }).join("");
    }

    // Monthly trend
    renderTrend(data.monthly_trend || []);

    // Sprint comparison
    renderSprintCompare(data.monthly_trend || []);

    // Burnout detector
    renderBurnout(data.burnout_alerts || []);

    // Review backlog
    renderReviewBacklog(data.review_backlog || [], data.review_backlog_summary || {});

    // Heatmap
    renderHeatmap(data.commit_heatmap);
  } catch (e) {
    document.getElementById("cycle-stats").innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

function renderTrend(weeks) {
  const wrap = document.getElementById("trend-chart");
  if (!wrap || !weeks.length) return;
  const max = Math.max(1, ...weeks.map((w) => w.merged));
  wrap.innerHTML = `
    <div style="display:flex;gap:3px;align-items:end;height:90px">
      ${weeks.map((w) => {
        const h = (w.merged / max) * 100;
        const cycleLabel = w.cycle_p50 != null ? `${w.cycle_p50}d` : "-";
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
          <span style="font-size:9px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${w.merged}</span>
          <div style="width:100%;max-width:30px;background:var(--bg-elevated);border-radius:3px 3px 0 0;height:60px;display:flex;align-items:end">
            <div style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;height:${h}%;min-height:2px;transition:height 0.3s"></div>
          </div>
          <span style="font-size:8px;color:var(--text-faint)">${w.label}</span>
        </div>`;
      }).join("")}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:10px;color:var(--text-faint)">
      <span>12 weeks ago</span>
      <span>Bar = PRs merged / Bottom = cycle time P50</span>
      <span>This week</span>
    </div>`;
}

function renderSprintCompare(weeks) {
  const wrap = document.getElementById("sprint-compare");
  if (!wrap || weeks.length < 2) { if (wrap) wrap.innerHTML = '<div class="loading">Need 2+ weeks of data.</div>'; return; }
  const thisWeek = weeks[weeks.length - 1];
  const lastWeek = weeks[weeks.length - 2];
  const twoAgo = weeks.length >= 3 ? weeks[weeks.length - 3] : null;

  const compare = (label, cur, prev) => {
    const diff = cur - prev;
    const pct = prev > 0 ? Math.round((diff / prev) * 100) : 0;
    const arrow = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const color = arrow === "up" ? "var(--success)" : arrow === "down" ? "var(--danger)" : "var(--text-muted)";
    return `<div class="cycle-stat">
      <div class="cycle-val" style="color:${color}">${cur}</div>
      <div class="cycle-label">${label}</div>
      <div style="font-size:9px;color:${color};margin-top:2px">${diff >= 0 ? "+" : ""}${diff} (${pct >= 0 ? "+" : ""}${pct}%)</div>
    </div>`;
  };

  wrap.innerHTML = `
    <div class="cycle-grid" style="grid-template-columns:repeat(3,1fr)">
      ${compare("This week PRs", thisWeek.merged, lastWeek.merged)}
      ${compare("Last week PRs", lastWeek.merged, twoAgo ? twoAgo.merged : lastWeek.merged)}
      <div class="cycle-stat">
        <div class="cycle-val">${thisWeek.cycle_p50 != null ? thisWeek.cycle_p50 + "d" : "—"}</div>
        <div class="cycle-label">Cycle P50 (this wk)</div>
      </div>
    </div>`;
}

function renderBurnout(alerts) {
  const block = document.getElementById("burnout-block");
  const list = document.getElementById("burnout-list");
  if (!block || !list) return;
  if (!alerts.length) { block.style.display = "none"; return; }
  block.style.display = "";
  list.innerHTML = alerts.map((a) => {
    const riskClass = a.risk === "high" ? "danger" : a.risk === "medium" ? "warning" : "";
    return `
      <div class="tp-row">
        <span class="person-avatar">${avatar(a.login)}</span>
        <span class="tp-name">${escapeHtml(a.login)}</span>
        <div style="flex:1">
          ${a.weekend_commits ? `<span class="label-tag">${a.weekend_commits} weekend</span> ` : ""}
          ${a.late_night_commits ? `<span class="label-tag">${a.late_night_commits} late-night</span> ` : ""}
        </div>
        <span class="label-tag ${riskClass ? `sev-${a.risk}` : ""}" style="${a.risk === 'high' ? 'background:var(--danger-soft);color:var(--danger)' : a.risk === 'medium' ? 'background:var(--warning-soft);color:var(--warning)' : ''}">${a.risk.toUpperCase()}</span>
      </div>`;
  }).join("");
}

function renderReviewBacklog(items, summary) {
  const stats = document.getElementById("backlog-stats");
  const list = document.getElementById("backlog-list");
  const badge = document.getElementById("backlog-badge");
  if (!stats || !list) return;

  const health = summary.health || "good";
  const healthClass = health === "good" ? "success" : health === "ok" ? "warning" : "danger";

  stats.innerHTML = `
    <div class="cycle-stat">
      <div class="cycle-val">${summary.total_open || 0}</div>
      <div class="cycle-label">Total open</div>
    </div>
    <div class="cycle-stat">
      <div class="cycle-val">${summary.median_wait || 0}<span class="cycle-unit">d</span></div>
      <div class="cycle-label">Median wait</div>
    </div>
    <div class="cycle-stat">
      <div class="cycle-val">${summary.waiting_over_1d || 0}</div>
      <div class="cycle-label">&gt; 1 day</div>
    </div>
    <div class="cycle-stat">
      <div class="cycle-val cycle-${healthClass}">${summary.waiting_over_3d || 0}</div>
      <div class="cycle-label">&gt; 3 days · ${health.toUpperCase()}</div>
    </div>`;

  if (badge) badge.textContent = `${summary.total_open || 0} PRs waiting`;

  if (!items.length) {
    list.innerHTML = '<div class="loading">No open PRs — all clear!</div>';
    return;
  }
  list.innerHTML = items.map((p) => {
    const repoShort = (p.repo || "").split("/").pop();
    return `
      <a href="${p.url}" target="_blank" class="backlog-pr sev-${p.severity}">
        <span class="backlog-pr-age">${p.age_days}d</span>
        <div>
          <div class="backlog-pr-title">#${p.number} ${escapeHtml(p.title)}</div>
          <div class="backlog-pr-meta">@${escapeHtml(p.author)} · ${escapeHtml(repoShort)}</div>
        </div>
        <span class="label-tag">${p.severity === "red" ? "urgent" : p.severity === "yellow" ? "stale" : "ok"}</span>
      </a>`;
  }).join("");
}

function renderHeatmap(data) {
  const wrap = document.getElementById("heatmap-wrap");
  const devs = Object.keys(data || {});
  if (!devs.length) {
    wrap.innerHTML = '<div class="loading">No commits in last 30 days yet.</div>';
    return;
  }
  // Build last 30 days
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const max = Math.max(1, ...devs.flatMap((d) => Object.values(data[d])));
  const intensity = (n) => {
    if (!n) return 0;
    const r = n / max;
    if (r > 0.66) return 4;
    if (r > 0.33) return 3;
    if (r > 0.1) return 2;
    return 1;
  };
  let html = '<table class="heatmap"><thead><tr><th></th>';
  for (const day of days) {
    const dow = new Date(day).getDay();
    const isWeekend = dow === 0 || dow === 6;
    html += `<th class="${isWeekend ? "wknd" : ""}" title="${day}">${day.slice(8, 10)}</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const dev of devs) {
    html += `<tr><td class="hm-name">${escapeHtml(dev)}</td>`;
    for (const day of days) {
      const n = data[dev][day] || 0;
      html += `<td class="hm-cell hm-${intensity(n)}" title="${dev} on ${day}: ${n} commits"></td>`;
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  wrap.innerHTML = html;
}

// ======= HASH ROUTING =======
const TAB_LOADERS = {
  overview: loadOverview,
  roadmap: async () => { await loadRoadmap(); try { const d = await fetchJson("/api/github?days=0"); renderBurndown(d.burndown); } catch {} },
  kanban: loadGithub,
  performance: loadPerformance,
  sheets: loadSheets,
  assign: loadAssign,
  inbox: loadInboxHistory,
};

function switchTab(slug) {
  if (!slug || !document.getElementById(`tab-${slug}`)) slug = "overview";
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
  const tabBtn = document.querySelector(`.tab[data-tab="${slug}"]`);
  if (tabBtn) tabBtn.classList.add("active");
  const panel = document.getElementById(`tab-${slug}`);
  if (panel) panel.classList.add("active");
  if (TAB_LOADERS[slug]) TAB_LOADERS[slug]();
  document.title = `${slug.charAt(0).toUpperCase() + slug.slice(1)} — PM Command Center`;
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.hash = t.dataset.tab;
  })
);
window.addEventListener("hashchange", () => switchTab(window.location.hash.replace("#", "")));
function initFromHash() { switchTab(window.location.hash.replace("#", "") || "overview"); }

// Refresh button: reset all filters + reload
// Kanban filter events — re-render from cached data (no API call)
["filter-assignee", "filter-repo", "filter-group"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    if (_kanbanData) renderKanban(_kanbanData);
  });
});
document.getElementById("filter-search")?.addEventListener("input", () => {
  if (_kanbanData) renderKanban(_kanbanData);
});
document.getElementById("kanban-compact-toggle")?.addEventListener("click", (e) => {
  const kanban = document.getElementById("kanban");
  kanban.classList.toggle("compact");
  e.target.textContent = kanban.classList.contains("compact") ? "Expanded" : "Compact";
});

document.getElementById("refresh-btn").addEventListener("click", () => {
  filterDays = 7;
  filterFrom = "";
  filterTo = "";
  localStorage.setItem("filterDays", 7);
  localStorage.removeItem("filterFrom");
  localStorage.removeItem("filterTo");
  setActiveFilter(7);
  document.getElementById("date-range").style.display = "none";
  loadGithub();
  // Also reload current tab data
  const slug = window.location.hash.replace("#", "") || "overview";
  if (TAB_LOADERS[slug]) TAB_LOADERS[slug]();
});

// Time filter
function setActiveFilter(days) {
  document.querySelectorAll("#time-filter .filter-btn").forEach((b) => b.classList.remove("active"));
  const match = document.querySelector(`#time-filter .filter-btn[data-days="${days}"]`);
  if (match) match.classList.add("active");
}

function applyPresetFilter(days) {
  filterDays = days;
  filterFrom = "";
  filterTo = "";
  localStorage.setItem("filterDays", days);
  localStorage.removeItem("filterFrom");
  localStorage.removeItem("filterTo");
  setActiveFilter(days);
  document.getElementById("date-range").style.display = "none";
  loadGithub();
}

function applyCustomFilter() {
  const from = document.getElementById("date-from").value;
  const to = document.getElementById("date-to").value;
  if (!from || !to) return;
  if (from > to) { alert("'From' must be before 'To'"); return; }
  filterFrom = from;
  filterTo = to;
  filterDays = 0;
  localStorage.setItem("filterFrom", from);
  localStorage.setItem("filterTo", to);
  localStorage.setItem("filterDays", 0);
  setActiveFilter("custom");
  loadGithub();
}

// Init filter state
(function initFilter() {
  if (filterFrom && filterTo) {
    setActiveFilter("custom");
    document.getElementById("date-range").style.display = "flex";
    document.getElementById("date-from").value = filterFrom;
    document.getElementById("date-to").value = filterTo;
  } else {
    setActiveFilter(filterDays);
  }
})();

document.querySelectorAll("#time-filter .filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.days === "custom") {
      const range = document.getElementById("date-range");
      const show = range.style.display === "none";
      range.style.display = show ? "flex" : "none";
      if (show) {
        // Default: last 30 days
        const today = new Date().toISOString().slice(0, 10);
        const month = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        if (!document.getElementById("date-from").value) document.getElementById("date-from").value = month;
        if (!document.getElementById("date-to").value) document.getElementById("date-to").value = today;
        document.getElementById("date-from").focus();
      }
      setActiveFilter("custom");
    } else {
      applyPresetFilter(parseInt(btn.dataset.days));
    }
  });
});

document.getElementById("date-apply").addEventListener("click", applyCustomFilter);

// Enter key in date fields triggers apply
document.querySelectorAll("#date-range input[type=date]").forEach((input) => {
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustomFilter(); });
});

// Keyboard shortcut: R to refresh
document.addEventListener("keydown", (e) => {
  if (e.key === "r" && !e.metaKey && !e.ctrlKey && document.activeElement.tagName !== "INPUT") {
    loadGithub();
  }
});

// Client view: show only Overview, Roadmap, Kanban
if (new URLSearchParams(window.location.search).get("view") === "client") {
  document.querySelectorAll('.tab[data-tab="performance"], .tab[data-tab="people"], .tab[data-tab="sheets"], .tab[data-tab="inbox"], .tab[data-tab="assign"]').forEach((t) => t.style.display = "none");
  document.querySelector(".metrics")?.remove();
  document.querySelector("header .badge.live")?.remove();
  document.querySelector(".ov-wip")?.remove(); // hide WIP details
  document.querySelector(".ov-stale")?.remove(); // hide stale
  document.querySelector("[id='plan-sprint-btn']")?.parentElement?.parentElement?.remove(); // hide sprint planner
  const h1 = document.querySelector("header h1");
  if (h1) h1.textContent = "Project Dashboard";
}

// ===== REPORT BUTTONS =====
function reportButton(btnId, endpoint, label) {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    const btn = document.getElementById(btnId);
    btn.disabled = true; btn.textContent = "...";
    try {
      const r = await fetch(endpoint);
      const d = await r.json();
      btn.textContent = d.ok ? "Sent" : "Failed";
    } catch (e) {
      btn.textContent = "Failed";
    }
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 3000);
  });
}
reportButton("run-morning-btn", "/api/cron/morning", "AM");
reportButton("run-eod-btn", "/api/cron/eod", "EOD");
reportButton("run-weekly-btn", "/api/cron/weekly", "Weekly");

// ===== REPORT EDITOR =====
let _lastReportText = "";

// Override report buttons to capture output for editing
function reportButtonWithEdit(btnId, endpoint, label) {
  document.getElementById(btnId)?.addEventListener("click", async () => {
    const btn = document.getElementById(btnId);
    btn.disabled = true; btn.textContent = "...";
    try {
      const r = await fetch(endpoint);
      const d = await r.json();
      btn.textContent = d.ok ? "Sent" : "Failed";
      // Store summary for editing
      if (d.summary_excerpt) _lastReportText = d.summary_excerpt;
    } catch (e) { btn.textContent = "Failed"; }
    setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 3000);
  });
}
// Re-bind buttons with edit-aware version
reportButtonWithEdit("run-morning-btn", "/api/cron/morning", "AM");
reportButtonWithEdit("run-eod-btn", "/api/cron/eod", "EOD");
reportButtonWithEdit("run-weekly-btn", "/api/cron/weekly", "Weekly");

// Edit button opens editor with last report or empty
document.getElementById("edit-report-btn")?.addEventListener("click", () => {
  document.getElementById("report-editor").classList.remove("hidden");
  document.getElementById("editor-text").value = _lastReportText || "Click AM, EOD, or Weekly first to generate a report, then click Edit to modify it.\n\nOr type your own report here.";
  document.getElementById("editor-text").focus();
});
document.getElementById("editor-close")?.addEventListener("click", () => document.getElementById("report-editor").classList.add("hidden"));
document.getElementById("editor-overlay")?.addEventListener("click", () => document.getElementById("report-editor").classList.add("hidden"));

// Tab switching
document.querySelectorAll("[data-etab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-etab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("editor-edit-panel").style.display = btn.dataset.etab === "edit" ? "" : "none";
    document.getElementById("editor-ai-panel").style.display = btn.dataset.etab === "ai" ? "" : "none";
  });
});

// AI rewrite
document.getElementById("editor-ai-btn")?.addEventListener("click", async () => {
  const instruction = document.getElementById("editor-ai-input")?.value?.trim();
  const currentText = document.getElementById("editor-text")?.value?.trim();
  if (!instruction || !currentText) return;

  const btn = document.getElementById("editor-ai-btn");
  btn.disabled = true; btn.textContent = "Rewriting...";
  try {
    const r = await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "chat", question: `Rewrite this report following this instruction: "${instruction}"\n\nOriginal report:\n${currentText}\n\nReturn ONLY the rewritten text, nothing else.` }),
    });
    const d = await r.json();
    if (d.answer) {
      document.getElementById("editor-text").value = d.answer;
      _lastReportText = d.answer;
    }
  } catch (e) {}
  btn.disabled = false; btn.textContent = "Rewrite with AI";
});

// Send edited text to Discord
document.getElementById("editor-send-discord")?.addEventListener("click", async () => {
  const text = document.getElementById("editor-text")?.value?.trim();
  if (!text) return;
  const btn = document.getElementById("editor-send-discord");
  btn.disabled = true; btn.textContent = "Sending...";
  try {
    const webhook = await fetch("/api/config?type=discord-info").then(() => null).catch(() => null);
    // Use the chat endpoint to post to Discord via a workaround
    await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send-discord", text }),
    });
    btn.textContent = "Sent";
    setTimeout(() => { btn.textContent = "Send to Discord"; btn.disabled = false; }, 3000);
  } catch (e) {
    btn.textContent = "Failed";
    setTimeout(() => { btn.textContent = "Send to Discord"; btn.disabled = false; }, 3000);
  }
});

// Copy text
document.getElementById("editor-copy")?.addEventListener("click", () => {
  const text = document.getElementById("editor-text")?.value;
  if (text) { navigator.clipboard.writeText(text); document.getElementById("editor-copy").textContent = "Copied"; setTimeout(() => document.getElementById("editor-copy").textContent = "Copy text", 2000); }
});

// ===== AI CHAT =====
document.getElementById("ai-chat-toggle")?.addEventListener("click", () => {
  document.getElementById("ai-chat").classList.toggle("hidden");
  document.getElementById("ai-chat-box")?.focus();
});
document.getElementById("ai-chat-close")?.addEventListener("click", () => {
  document.getElementById("ai-chat").classList.add("hidden");
});

async function sendChat() {
  const input = document.getElementById("ai-chat-box");
  const q = input?.value?.trim();
  if (!q) return;

  const msgs = document.getElementById("ai-chat-messages");
  msgs.innerHTML += `<div class="ai-msg ai-user">${escapeHtml(q)}</div>`;
  msgs.innerHTML += `<div class="ai-msg ai-loading" id="ai-typing">Thinking...</div>`;
  msgs.scrollTop = msgs.scrollHeight;
  input.value = "";

  try {
    const r = await fetch("/api/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "chat", question: q }),
    });
    const d = await r.json();
    document.getElementById("ai-typing")?.remove();
    msgs.innerHTML += `<div class="ai-msg ai-bot">${escapeHtml(d.answer || d.error || "No response")}</div>`;
  } catch (e) {
    document.getElementById("ai-typing")?.remove();
    msgs.innerHTML += `<div class="ai-msg ai-bot">${escapeHtml(e.message)}</div>`;
  }
  msgs.scrollTop = msgs.scrollHeight;
}

document.getElementById("ai-chat-send")?.addEventListener("click", sendChat);
document.getElementById("ai-chat-box")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

// Init — load once on page open, no auto-polling
loadGithub();
initFromHash();
