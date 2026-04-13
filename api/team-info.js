// GET /api/team-info — returns the team config (no secrets, just routing rules).
export default function handler(req, res) {
  let team = {};
  try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}
  res.json({ team });
}
