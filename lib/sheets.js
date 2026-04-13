// Google Sheets — read via "Publish to web → CSV" public URL OR
// "anyone with link can view" + auto-converted export URL.
//
// To set up: paste either:
//   - https://docs.google.com/spreadsheets/d/<ID>/edit?gid=0#gid=0  (we auto-convert)
//   - or the publish-as-CSV URL

function normalizeSheetUrl(url) {
  if (!url) return null;
  // Convert /edit URL to /export?format=csv
  const m = url.match(/\/spreadsheets\/d\/([^\/]+)/);
  if (m && url.includes("/edit")) {
    const id = m[1];
    const gidMatch = url.match(/[#?&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }
  return url;
}

export async function fetchSheet() {
  const url = normalizeSheetUrl(process.env.GOOGLE_SHEETS_URL);
  if (!url) return { error: "GOOGLE_SHEETS_URL not configured", rows: [] };

  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`Sheets fetch ${r.status}`);
    const text = await r.text();
    return { rows: parseCsv(text) };
  } catch (e) {
    return { error: e.message, rows: [] };
  }
}

// Parse "M/D/YYYY" or "MM/DD/YYYY" → Date
function parseSheetDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return new Date(+m[3], +m[1] - 1, +m[2]);
}

// Format Date as M/D/YYYY
function formatSheetDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// Filter rows by date (carry forward "current date" across rows that have empty date col)
export function rowsForDate(rows, targetDate) {
  const target = formatSheetDate(targetDate);
  let currentDate = "";
  const matches = [];
  // try common date column names
  const dateKey = Object.keys(rows[0] || {}).find((k) => /date|^-$/i.test(k.trim())) || Object.keys(rows[0] || {})[0];
  for (const row of rows) {
    const rowDate = (row[dateKey] || "").trim();
    if (rowDate) currentDate = rowDate;
    if (currentDate === target) {
      const member = (row.Member || row.member || "").trim();
      if (member) matches.push({ ...row, _date: currentDate });
    }
  }
  return matches;
}

// Get yesterday + today (Hanoi time)
export function hanoiToday() {
  // Hanoi = UTC+7
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 7 * 3600000);
}
export function hanoiYesterday() {
  const t = hanoiToday();
  t.setDate(t.getDate() - 1);
  return t;
}

function parseCsv(text) {
  // Tiny CSV parser — handles quoted fields with commas.
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (vals[i] || "").trim();
    });
    return obj;
  });
}

function parseRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
