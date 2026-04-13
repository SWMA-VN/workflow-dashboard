// GET /api/discord-info — returns server ID for widget embed (public, no secret).
export default function handler(req, res) {
  res.json({ server_id: process.env.DISCORD_SERVER_ID || null });
}
