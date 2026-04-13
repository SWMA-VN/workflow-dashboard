// GET /api/sheets
// Returns rows from configured Google Sheet (published as CSV).

import { fetchSheet } from "../lib/sheets.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const data = await fetchSheet();
  res.json({
    generated_at: new Date().toISOString(),
    source: process.env.GOOGLE_SHEETS_URL ? "configured" : "not configured",
    ...data,
  });
}
