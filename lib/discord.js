// Discord webhook — outbound only.
// Posts messages and embeds to a configured webhook URL.

export async function postDiscord({ content, embeds, username = "PM Bot" } = {}) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) {
    console.log("[discord] No webhook configured");
    return false;
  }
  const payload = { username };
  if (content) payload.content = content.slice(0, 2000);
  if (embeds && embeds.length) payload.embeds = embeds.slice(0, 10);

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    console.error(`[discord] Failed ${r.status}: ${await r.text()}`);
    return false;
  }
  return true;
}

export function makeEmbed({ title, description, fields, color = 0x1F4E79, url } = {}) {
  const embed = { title, description, color };
  if (url) embed.url = url;
  if (fields) {
    embed.fields = fields.map((f) => ({
      name: f.name,
      value: f.value,
      inline: f.inline ?? false,
    }));
  }
  embed.timestamp = new Date().toISOString();
  return embed;
}
