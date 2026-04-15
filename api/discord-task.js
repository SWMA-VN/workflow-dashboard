// POST /api/discord-task
// Discord slash command handler for `/task <description>`.
// Creates a GitHub issue from the message → auto-assign fires via webhook.
//
// Setup (one-time):
//   1. Discord Dev Portal: create app → get Public Key + Application ID
//   2. Env: DISCORD_PUBLIC_KEY, DISCORD_APP_ID, DISCORD_BOT_TOKEN (optional)
//   3. Register command: POST to Discord API (use /api/discord-task?register=1)
//   4. Set interaction URL in Discord app → https://workflowview.vercel.app/api/discord-task
//   5. Invite bot to server with applications.commands scope

import nacl from "tweetnacl";

export const config = { api: { bodyParser: false } };

const GH_API = "https://api.github.com";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function verifyDiscord(body, signature, timestamp, publicKey) {
  try {
    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp), body]),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex"),
    );
  } catch {
    return false;
  }
}

async function registerCommand() {
  const appId = process.env.DISCORD_APP_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!appId || !botToken) return { error: "Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN" };

  const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "task",
      description: "Create a GitHub task from Discord (auto-assigns to right dev)",
      options: [
        { name: "description", description: "What needs to be done", type: 3, required: true },
        { name: "priority", description: "Priority level", type: 3, required: false,
          choices: [{ name: "P0", value: "p0" }, { name: "P1", value: "p1" }, { name: "P2", value: "p2" }] },
      ],
    }),
  });
  return { status: r.status, body: await r.text() };
}

export default async function handler(req, res) {
  // Registration endpoint (one-time admin use)
  if (req.query?.register === "1") {
    const result = await registerCommand();
    return res.json(result);
  }

  if (req.method !== "POST") return res.status(405).end();

  const raw = await readRawBody(req);
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) return res.status(500).json({ error: "DISCORD_PUBLIC_KEY not set" });
  if (!signature || !timestamp) return res.status(401).end();
  if (!verifyDiscord(raw, signature, timestamp, publicKey)) return res.status(401).send("invalid signature");

  const body = JSON.parse(raw.toString());

  // PING = Discord verifying the endpoint
  if (body.type === 1) return res.json({ type: 1 });

  // APPLICATION_COMMAND
  if (body.type === 2 && body.data?.name === "task") {
    const description = (body.data.options || []).find((o) => o.name === "description")?.value || "";
    const priority = (body.data.options || []).find((o) => o.name === "priority")?.value || "p1";
    const author = body.member?.user?.username || body.user?.username || "unknown";

    if (!description) {
      return res.json({ type: 4, data: { content: "Please provide a task description.", flags: 64 } });
    }

    // Create issue in default repo (workflow-dashboard); AI Inbox routes when it matters more
    const repo = process.env.GITHUB_REPO || `${process.env.GITHUB_ORG || "SWMA-VN"}/workflow-dashboard`;
    const title = description.length > 80 ? description.slice(0, 77) + "..." : description;

    try {
      const ghRes = await fetch(`${GH_API}/repos/${repo}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: `[DISCORD] ${title}`,
          body: `${description}\n\n---\nCreated from Discord by **@${author}** via \`/task\` slash command.\nAuto-assign will fire within 5 seconds.`,
          labels: ["discord", priority],
        }),
      });
      if (!ghRes.ok) throw new Error(`GitHub ${ghRes.status}`);
      const issue = await ghRes.json();

      return res.json({
        type: 4,
        data: {
          content: `**Task created:** [#${issue.number}](${issue.html_url}) ${title}\nAuto-assign is picking the right dev now.`,
        },
      });
    } catch (e) {
      return res.json({ type: 4, data: { content: `Failed to create task: ${e.message}`, flags: 64 } });
    }
  }

  res.json({ type: 1 });
}
