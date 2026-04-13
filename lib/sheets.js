// Google Sheets reader for the SWMA team standup log.
//
// Sheet structure (positional columns, schema may evolve so we read by INDEX):
//   col 0: Date (M/D/YYYY) — present only on first row of a day
//   col 1: Section marker "Morning" / "Afternoon" — present only on first row of section
//   col 2: Member name — carries forward to subsequent empty rows
//   col 3: Tag — "Yesterday" / "Today" / "Done" / "InProgress"
//   col 4: Content (what was done / what's planned) — multi-line allowed
//   col 5: Progress (%)
//   col 6: Tomorrow plan (often empty when col 4 is used)
//   col 7: Link
//   col 8: Any issues
//
// Pattern per day:
//   Morning section: per member → Yesterday + Today rows
//   Afternoon section: per member → Done + InProgress rows

function normalizeSheetUrl(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([^\/]+)/);
  if (m && url.includes("/edit")) {
    const id = m[1];
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  return url;
}

// Robust CSV parser — handles quoted fields with embedded commas + newlines.
// Returns 2D array of strings.
export function parseCsv2D(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Backward-compatible: returns array of objects keyed by header.
export function parseCsv(text) {
  const rows = parseCsv2D(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => (h || "").trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || "").trim(); });
    return obj;
  });
}

export async function fetchSheetRaw() {
  const url = normalizeSheetUrl(process.env.GOOGLE_SHEETS_URL);
  if (!url) return { error: "GOOGLE_SHEETS_URL not configured", text: "" };
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`Sheets fetch ${r.status}`);
    return { text: await r.text() };
  } catch (e) {
    return { error: e.message, text: "" };
  }
}

export async function fetchSheet() {
  const { text, error } = await fetchSheetRaw();
  if (error) return { error, rows: [] };
  return { rows: parseCsv(text) };
}

// ===== STANDUP-AWARE PARSER =====
// Returns: { "M/D/YYYY": { morning: { [Member]: { yesterday, today } }, afternoon: { [Member]: { done, inprogress, issues } } } }
export function parseStandupActivity(text) {
  const rows = parseCsv2D(text);
  if (rows.length < 2) return {};
  const data = rows.slice(1); // skip header

  const days = {};
  let curDate = null, curSection = null, curMember = null;

  for (const r of data) {
    const date = (r[0] || "").trim();
    const sectionOrNote = (r[1] || "").trim();
    const member = (r[2] || "").trim();
    const tag = (r[3] || "").trim();
    const content = (r[4] || "").trim();
    const progress = (r[5] || "").trim();
    const issues = (r[8] || "").trim();

    if (date) {
      curDate = date;
      curSection = null;
      curMember = null;
    }
    // Section markers are EXACT strings only (not arbitrary PM notes)
    if (sectionOrNote === "Morning" || sectionOrNote === "Afternoon") {
      curSection = sectionOrNote.toLowerCase();
      curMember = null;
    }
    if (member) curMember = member;

    if (!curDate || !curSection || !curMember || !tag) continue;

    if (!days[curDate]) days[curDate] = { morning: {}, afternoon: {} };
    const sec = days[curDate][curSection];
    if (!sec[curMember]) sec[curMember] = {};
    const m = sec[curMember];

    const key = tag.toLowerCase().replace(/\s+/g, "");
    // Map common variants
    const mapped = key === "inprogress" ? "inProgress" : key;
    if (content) m[mapped] = content;
    if (progress) m.progress = progress;
    if (issues) m.issues = (m.issues ? m.issues + " | " : "") + issues;
  }

  return days;
}

export async function getDayActivity(targetDate) {
  const { text, error } = await fetchSheetRaw();
  if (error) return { error, day: null };
  const all = parseStandupActivity(text);
  const key = formatSheetDate(targetDate);
  return { day: all[key] || { morning: {}, afternoon: {} }, key };
}

// ===== DATE HELPERS (Hanoi UTC+7) =====
export function hanoiToday() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 7 * 3600000);
}

export function hanoiYesterday() {
  const t = hanoiToday();
  t.setDate(t.getDate() - 1);
  return t;
}

// Last working day before `d` (Mon→Fri, Sun→Fri, Sat→Fri)
export function lastWorkdayBefore(d) {
  const out = new Date(d);
  out.setDate(out.getDate() - 1);
  while (out.getDay() === 0 || out.getDay() === 6) out.setDate(out.getDate() - 1);
  return out;
}

export function formatSheetDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

export function parseSheetDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2]);
}

// Legacy compat (used by older code) — not the rich version
export function rowsForDate(rows, targetDate) {
  const target = formatSheetDate(targetDate);
  let currentDate = "";
  const matches = [];
  if (!rows.length) return matches;
  const dateKey = Object.keys(rows[0]).find((k) => /date|^-$/i.test(k.trim())) || Object.keys(rows[0])[0];
  for (const row of rows) {
    const rowDate = (row[dateKey] || "").trim();
    if (rowDate) currentDate = rowDate;
    if (currentDate === target) {
      const member = (row.Member || row.member || row[Object.keys(row)[2]] || "").trim();
      if (member) matches.push({ ...row, _date: currentDate });
    }
  }
  return matches;
}
