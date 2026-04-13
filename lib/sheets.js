// Google Sheets — read via "Publish to web → CSV" public URL.
// No API key, no OAuth. User publishes a sheet, we fetch the CSV.
//
// To set up:
//   In Google Sheets → File → Share → Publish to web → Comma-separated values → Publish
//   Copy the URL, paste into env GOOGLE_SHEETS_URL.

export async function fetchSheet() {
  const url = process.env.GOOGLE_SHEETS_URL;
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
