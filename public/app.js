// PM Command Center — public dashboard.
// All data fetched via /api/* (server-side, secrets stay safe).

const REFRESH_MS = 30_000;

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
    return hrs < 1 ? "just now" : `${hrs}h ago`;
  }
  return `${days}d ago`;
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
    for (const issue of items) {
      const isBlocker = issue.labels.some((l) => l.toLowerCase().includes("block"));
      const isMerged = issue.labels.includes("merged");
      const card = document.createElement("a");
      card.className = "card" + (isBlocker ? " blocker" : "") + (isMerged ? " merged" : "");
      card.href = issue.url;
      card.target = "_blank";
      const labels = issue.labels
        .filter((l) => !["pull-request", "merged"].includes(l.toLowerCase()))
        .slice(0, 3)
        .map((l) => `<span class="label-tag">${escapeHtml(l)}</span>`)
        .join("");
      const assignees = issue.assignees
        .map((a) => `<span class="assignee" title="${escapeHtml(a)}">${escapeHtml(a.slice(0, 2).toUpperCase())}</span>`)
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
    root.innerHTML = '<div class="loading">No activity yet.</div>';
    return;
  }
  for (const [login, s] of sorted) {
    const card = document.createElement("div");
    card.className = "person-card";
    card.innerHTML = `
      <div class="person-name">${escapeHtml(login)}</div>
      <div class="person-stats">
        <div class="person-stat"><div class="person-stat-val">${s.commits}</div><div class="person-stat-label">Commits</div></div>
        <div class="person-stat"><div class="person-stat-val">${s.prs}</div><div class="person-stat-label">PRs</div></div>
        <div class="person-stat"><div class="person-stat-val">${s.issues}</div><div class="person-stat-label">Open</div></div>
      </div>`;
    root.appendChild(card);
  }
}

async function loadGithub() {
  document.getElementById("last-updated").textContent = "loading…";
  try {
    const data = await fetchJson("/api/github");
    document.getElementById("repo-name").textContent = data.repo;
    document.getElementById("repo-link").href = `https://github.com/${data.repo}`;
    renderKanban(data);
    renderMetrics(data);
    renderPeople(data);
    document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    document.getElementById("last-updated").textContent = `error: ${e.message}`;
    document.getElementById("kanban").innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}<br><br>Check that <code>GITHUB_TOKEN</code> + <code>GITHUB_REPO</code> are set in Vercel env.</div>`;
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
    if (data.rows.length > 100) html += `<p class="hint">Showing first 100 of ${data.rows.length} rows.</p>`;
    wrap.innerHTML = html;
  } catch (e) {
    wrap.innerHTML = `<div class="loading">⚠️ ${escapeHtml(e.message)}</div>`;
  }
}

async function loadDiscord() {
  // Fetch server ID from a public endpoint, fall back to env if exposed.
  // We expose just the server id via a simple API for the widget URL.
  try {
    const r = await fetch("/api/discord-info");
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
    const r = await fetch("/api/team-info");
    if (r.ok) {
      const data = await r.json();
      document.getElementById("team-config").textContent = JSON.stringify(data.team, null, 2);
    }
  } catch (e) {
    document.getElementById("team-config").textContent = "Could not load team config";
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

// Tabs
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById(`tab-${t.dataset.tab}`).classList.add("active");
    if (t.dataset.tab === "sheets") loadSheets();
    if (t.dataset.tab === "discord") loadDiscord();
    if (t.dataset.tab === "assign") loadAssign();
  })
);

document.getElementById("refresh-btn").addEventListener("click", loadGithub);

// Init
loadGithub();
setInterval(loadGithub, REFRESH_MS);
