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

const COLUMNS = ["Todo", "In Progress", "In Review", "Testing", "Blocked", "Done"];

function renderKanban(data) {
  const root = document.getElementById("kanban");
  root.innerHTML = "";
  for (const col of COLUMNS) {
    const items = data.columns[col] || [];
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.col = col;
    colEl.innerHTML = `<div class="column-header"><span>${col}</span><span class="col-count">${items.length}</span></div>`;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--text-faint);font-size:11px;text-align:center;padding:20px 0;font-style:italic";
      empty.textContent = "—";
      colEl.appendChild(empty);
    }
    for (const issue of items) {
      const isBlocker = issue.labels.some((l) => l.toLowerCase().includes("block"));
      const isMerged = issue.labels.includes("merged");
      const card = document.createElement("a");
      card.className = "card" + (isBlocker ? " blocker" : "") + (isMerged ? " merged" : "");
      card.href = issue.url;
      card.target = "_blank";
      card.rel = "noopener";
      const labels = issue.labels
        .filter((l) => !["pull-request", "merged"].includes(l.toLowerCase()))
        .slice(0, 3)
        .map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`)
        .join("");
      const assignees = issue.assignees
        .map((a) => `<span class="assignee" title="${escapeHtml(a)}">${avatar(a)}</span>`)
        .join("");
      card.innerHTML = `
        <div class="card-num">#${issue.number}</div>
        <div class="card-title">${escapeHtml(issue.title)}</div>
        <div class="card-meta">${assignees}${labels}<span class="card-age">${ago(issue.updated_at)}</span></div>`;
      colEl.appendChild(card);
    }
    root.appendChild(colEl);
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
    const filterQuery = filterFrom && filterTo
      ? `from=${filterFrom}&to=${filterTo}`
      : `days=${filterDays}`;
    let data;
    try {
      data = await fetchJson(`/api/github?${filterQuery}`);
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

async function loadDiscord() {
  try {
    const r = await fetch("/api/config?type=discord-info");
    if (r.ok) {
      const { server_id } = await r.json();
      if (server_id) {
        document.getElementById("discord-widget-wrap").innerHTML =
          `<iframe src="https://discord.com/widget?id=${encodeURIComponent(server_id)}&theme=dark" allowtransparency="true" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
           <p class="hint" style="margin-top:12px">Tip: enable Server Widget in Discord → Server Settings → Widget.</p>`;
        return;
      }
    }
  } catch (e) {}
  document.getElementById("discord-widget-wrap").innerHTML =
    'Set <code>DISCORD_SERVER_ID</code> env var in Vercel + enable Server Widget in Discord. See <code>docs/06_discord_widget.md</code>.';
}

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
async function loadOverview() {
  await Promise.all([loadMilestones(), loadWip(), loadVelocity(), loadStale()]);
}

async function loadMilestones() {
  const wrap = document.getElementById("milestones-list");
  if (!wrap) return;
  try {
    const data = await fetchJson(`/api/github?days=${filterDays}`);
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
      return `
        <a href="${m.url}" target="_blank" class="milestone-row status-${m.status}">
          <div>
            <div class="milestone-title">${escapeHtml(m.title)}</div>
            <div class="milestone-meta">
              ${m.closed}/${m.total} tasks · repo: ${escapeHtml(repoName)}
              ${targetDate ? ` · target: ${targetDate}` : ""}
              ${forecastDate ? ` · forecast: ${forecastDate} (${offsetLabel})` : ""}
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
  kanban: loadGithub,
  performance: loadPerformance,
  sheets: loadSheets,
  discord: loadDiscord,
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

// Init — load once on page open, no auto-polling
loadGithub();
initFromHash();
