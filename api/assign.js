// POST /api/assign?issue=42
// Manually trigger auto-assignment for a specific issue.
// Useful for re-assigning, or testing the algorithm.

import { listIssues } from "../lib/github.js";
import { assignAndAnnounce, pickAssignee } from "../lib/assign.js";
import { postDiscord, makeEmbed } from "../lib/discord.js";

export default async function handler(req, res) {
  const issueNumber = parseInt(req.query.issue);
  const dryRun = req.query.dry === "1";
  if (!issueNumber) {
    return res.status(400).json({ error: "Pass ?issue=<number>" });
  }

  try {
    // Fetch the specific issue
    const all = await listIssues({ state: "open" });
    const issue = all.find((i) => i.number === issueNumber);
    if (!issue) return res.status(404).json({ error: `Issue #${issueNumber} not found` });

    if (dryRun) {
      const pick = await pickAssignee(issue);
      return res.json({ dry_run: true, ...pick });
    }

    const result = await assignAndAnnounce(issue);
    if (result.ok) {
      await postDiscord({
        embeds: [
          makeEmbed({
            title: `🤖 Auto-assigned #${issueNumber}`,
            url: issue.html_url,
            description: `**${issue.title}**\nAssigned to **@${result.dev}**\n_${result.reason}_`,
            color: 0x9B59B6,
          }),
        ],
      });
    }
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
