// GET /api/config?type=discord-info|team-info
// Merged: was discord-info + team-info. Saves 1 function slot for Discord /task command.

export default function handler(req, res) {
  const type = req.query?.type;
  if (type === "discord-info") {
    return res.json({ server_id: process.env.DISCORD_SERVER_ID || null });
  }
  if (type === "team-info") {
    let team = {};
    try { team = JSON.parse(process.env.TEAM_CONFIG || "{}"); } catch {}
    return res.json({ team });
  }
  res.status(400).json({ error: "pass ?type=discord-info or ?type=team-info" });
}
