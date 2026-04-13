# Discord Widget Embed (1 minute)

Show your Discord channel live on the dashboard — no bot needed.

## Step 1: Enable Server Widget

1. Open Discord → your server
2. **Server Settings** (top-left dropdown → Server Settings)
3. Left sidebar → **Widget**
4. Toggle **Enable Server Widget** = ON
5. Choose **Invite Channel** (which channel users land in if they click)
6. Copy the **Server ID** shown at the bottom

## Step 2: Add to Vercel

1. Vercel Dashboard → project → **Settings** → **Environment Variables**
2. Add: `DISCORD_SERVER_ID` = (paste server ID)
3. **Save** → **Redeploy**

## Step 3: View

Dashboard → 💬 **Discord** tab → live channel feed appears.

Shows:
- Online members
- Recent voice activity
- Invite link

---

## Privacy note

The widget is **public** — anyone with the dashboard URL can see who's online and the invite link.

If your dashboard is sensitive:
- Don't enable widget
- Or restrict dashboard with Vercel Auth (paid feature)
- Or use a private Discord channel for sensitive convos, public for general

---

## Want full message history?

Widget only shows online members + invite, not message history.

For message history:
- Build a Discord bot with `messages.read` intent
- Have it forward messages to your Vercel via webhook
- Display on dashboard

This is ~30 mins of extra work — ask me to add if you want it.
