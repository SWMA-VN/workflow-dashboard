# Environment Variables — All 8

Add these in Vercel Dashboard → your project → **Settings** → **Environment Variables**.
For each one: paste name + value, select all 3 environments (Production, Preview, Development), save.

---

## 1. `GITHUB_TOKEN` (Required)

**What:** Personal Access Token to read your repo + assign issues.

**How to get:**
1. Go to https://github.com/settings/tokens/new?scopes=repo,read:project,write:repo_hook
2. **Note:** "PM Command Center"
3. **Expiration:** No expiration (or 1 year)
4. Scopes already pre-selected: ✅ repo, ✅ read:project, ✅ write:repo_hook
5. Click **Generate token**
6. Copy the `ghp_...` value (Github won't show it again)

---

## 2. `GITHUB_REPO` (Required)

**What:** Your repo in `owner/name` format.

**Example:** `myorg/shopwithme-enrollment`

---

## 3. `GEMINI_API_KEY` (Required for AI summaries)

**What:** Free Google Gemini key for AI report summaries.

**How to get:**
1. Visit https://aistudio.google.com/apikey
2. Sign in with Google account
3. Click **Create API key**
4. Copy the key

**Free tier:** 2 million tokens/day. You'll never hit this.

---

## 4. `DISCORD_WEBHOOK` (Required for Discord posts)

**What:** Webhook URL for posting reports to a Discord channel.

**How to get:**
1. In Discord → Server → channel `#pm-reports`
2. Right-click channel → **Edit Channel** → **Integrations** → **Webhooks**
3. **New Webhook** → name it `PM Bot` → **Copy Webhook URL**

**Format:** `https://discord.com/api/webhooks/123/abc-xyz`

---

## 5. `GMAIL_USER` (Required for emails)

**What:** Your Gmail address that sends reports.

**Example:** `your.name@gmail.com`

---

## 6. `GMAIL_APP_PASSWORD` (Required for emails)

**What:** 16-character App Password (NOT your real password).

**How to get:**
1. Enable 2FA on Google: https://myaccount.google.com/security
2. Visit https://myaccount.google.com/apppasswords
3. App name: `PM Command Center` → **Create**
4. Copy the 16-char password (remove spaces)

**Format:** `abcdefghijklmnop` (16 chars, no spaces)

---

## 7. `EMAIL_TO` (Required for emails)

**What:** Comma-separated recipients of daily/weekly reports.

**Example:** `pm@company.com,lead@company.com,boss@company.com`

---

## 8. `TEAM_CONFIG` (Required for auto-assign)

**What:** JSON mapping dev GitHub usernames to skills + workload cap.

**Example:**
```json
{"alice":{"skills":["frontend","react"],"max_open":3},"bob":{"skills":["backend","payment"],"max_open":3},"carol":{"skills":["qa"],"max_open":5},"dan":{"skills":["fullstack","payment"],"max_open":3},"eve":{"skills":["frontend"],"max_open":3},"frank":{"skills":["backend","integration"],"max_open":3}}
```

**Available skill keywords** (used by engine to detect required skill from issue text):
- `frontend` → ui, react, vue, css, html, tailwind, step-X
- `backend` → api, server, database, node, python, express
- `payment` → hitpay, wechat, fps, stripe, checkout
- `qa` → test, test-case, tc-, bug
- `devops` → ci, cd, deploy, vercel, docker
- `integration` → bydesign, webhook, third-party
- `fullstack` → matches anything

**To validate JSON:** paste at https://jsonlint.com before saving in Vercel.

---

## Optional Vars

| Name | Default | Purpose |
|---|---|---|
| `PROJECT_NAME` | "Project" | Shown in reports |
| `TIMEZONE` | "Asia/Hong_Kong" | Used in date formatting |
| `DISCORD_SERVER_ID` | (none) | Enables Discord widget on dashboard |
| `GITHUB_WEBHOOK_SECRET` | (none) | Verifies webhook authenticity |
| `CRON_SECRET` | (none) | Restricts cron endpoints |
| `AI_PROVIDER` | "gemini" | Set to "claude" if you add Claude API key |
| `CLAUDE_API_KEY` | (none) | If you swap to Claude API later |

---

## After Adding All Vars

In Vercel Dashboard → **Deployments** → click ⋯ on latest → **Redeploy** (so new env vars take effect).
