# 🚀 Deploy in 10 Minutes

End result: live dashboard at `https://your-pm.vercel.app` (free).

---

## What You Need First

| | |
|---|---|
| GitHub account | (you have one for the dev repo) |
| Vercel account | sign up free at https://vercel.com (use "Continue with GitHub") |
| 8 secrets ready | from `.env.example` — see `02_env_vars.md` |

No credit card needed for any of this.

---

## Method A — Easiest (1-Click via GitHub)

### Step 1: Push this folder to GitHub

Open Terminal, run:

```bash
cd /Users/macbook/Downloads/pm-command-center-online

git init
git add .
git commit -m "Initial PM Command Center"

# Create a NEW repo on GitHub first (private is fine):
# https://github.com/new  → name it "pm-command-center" → Create

git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pm-command-center.git
git push -u origin main
```

### Step 2: Deploy on Vercel

1. Go to https://vercel.com/new
2. Click **Import Git Repository**
3. Find `pm-command-center` → click **Import**
4. **Framework Preset:** Other (auto-detected)
5. **Root Directory:** `./`
6. **Build Command:** leave empty
7. **Output Directory:** `public`
8. Click **Environment Variables** → add the 8 from `02_env_vars.md`
9. Click **Deploy**

### Step 3: Wait ~60 seconds

Vercel deploys. You'll get a URL like:
```
https://pm-command-center-abc123.vercel.app
```

### Step 4: Visit it

Open the URL → see live Kanban with your real GitHub data.

✅ **Done.** Daily reports start tomorrow at 9 AM. Weekly reports next Friday 5 PM.

---

## Method B — Vercel CLI (more control)

### Install CLI

```bash
npm install -g vercel
vercel login    # opens browser, sign in with GitHub
```

### Deploy

```bash
cd /Users/macbook/Downloads/pm-command-center-online
vercel               # first run: link or create project (answer prompts)
                     # → creates a preview deployment

vercel --prod        # promote to production
```

### Add env vars

```bash
vercel env add GITHUB_TOKEN
vercel env add GITHUB_REPO
vercel env add GEMINI_API_KEY
vercel env add DISCORD_WEBHOOK
vercel env add GMAIL_USER
vercel env add GMAIL_APP_PASSWORD
vercel env add EMAIL_TO
vercel env add TEAM_CONFIG
# then redeploy:
vercel --prod
```

---

## Step 5: Set Up GitHub Webhook (for auto-assign)

Open `04_setup_github_webhook.md` — takes 2 minutes.

## Step 6: Publish Google Sheet (for Sheets tab)

Open `03_setup_google_sheets.md` — takes 1 minute.

## Step 7: Enable Discord Widget (for Discord tab)

Open `06_discord_widget.md` — takes 1 minute.

---

## Custom Free Domain (later, optional)

Vercel gives you `*.vercel.app` for free. To use a custom domain:

- **Free option:** get a `.tk`, `.ml`, `.ga` from https://freenom.com (registration is currently limited though)
- **Cheap option:** `.xyz` from Namecheap (~$1/year)
- **Better:** point a subdomain you already own

Then in Vercel → Project → Settings → Domains → add your domain → follow DNS instructions.

---

## How to Verify Everything Works

### ✅ Test 1 — dashboard loads
- Visit `https://your-pm.vercel.app`
- Should see your repo name + Kanban populated

### ✅ Test 2 — daily report (manual trigger)
- Visit `https://your-pm.vercel.app/api/cron/daily` in browser
- Check Discord #pm-reports → should see embed
- Check email inbox → should see daily report
- Returns: `{"ok":true,...}` JSON

### ✅ Test 3 — auto-assign (dry run)
- Open dashboard → 🤖 Auto-Assign tab
- Enter an issue number → click "Test pick"
- Should show suggested assignee + reasoning

### ✅ Test 4 — webhook
- In your repo, create a test issue: `[TASK] Test auto-assign`
- Within ~5 sec → it should be auto-assigned
- Discord should ping with assignment

If any step fails → check Vercel Dashboard → your project → **Logs** tab.

---

## Cron Schedule (Vercel uses UTC)

Defined in `vercel.json`:

| Cron | UTC | HKT | What |
|---|---|---|---|
| `0 1 * * 1-5` | 01:00 Mon-Fri | **09:00 Mon-Fri** | Daily report |
| `0 9 * * 5` | 09:00 Fri | **17:00 Fri** | Weekly report |

To change times: edit `vercel.json` cron strings, redeploy.
