# PM Command Center — Online Edition

Live PM dashboard hosted at `https://your-name.vercel.app` (free).

**Real-time data from:** GitHub · Google Sheets · Discord
**Automated:** daily report (9 AM), weekly report (Fri 5 PM), task auto-assignment
**Cost:** $0 (Vercel hobby + Gemini free + Discord webhook + Gmail SMTP)

---

## What's Included

| Layer | Purpose |
|---|---|
| `public/` | Static dashboard (HTML/CSS/JS) — what users see |
| `api/` | Serverless functions (Node.js) — fetch GitHub/Sheets, post Discord |
| `api/cron/` | Scheduled jobs — daily + weekly reports auto-run |
| `lib/` | Shared helpers (GitHub, Sheets, Discord, AI, email, auto-assign) |
| `docs/` | Setup guides — read in order |

## Features

| Feature | Endpoint / Trigger |
|---|---|
| Live Kanban board | `/` (dashboard) |
| GitHub data API | `GET /api/github` |
| Google Sheets data | `GET /api/sheets` |
| Auto-assign | `POST /api/assign?issue=42` (also via webhook) |
| GitHub webhook receiver | `POST /api/webhook` |
| Daily report (auto) | Cron: 9 AM HKT weekdays → `/api/cron/daily` |
| Weekly report (auto) | Cron: Fri 5 PM HKT → `/api/cron/weekly` |
| Discord live widget | Embedded iframe in dashboard |

---

## Deploy in 10 Minutes

Read `docs/01_deploy.md` — it's step-by-step. Summary:

1. Push this folder to a new GitHub repo
2. Sign up free at https://vercel.com (with GitHub)
3. Click "Import Project" → pick your repo → Deploy
4. Add 8 environment variables (see `.env.example`)
5. Set up GitHub webhook (1 form, 30 sec)
6. Done — dashboard live at `https://your-project.vercel.app`

## Local Dev (optional)

```bash
npm install -g vercel
vercel login
cp .env.example .env.local
# edit .env.local with real values
vercel dev    # → http://localhost:3000
```

---

## Free Tier Limits (you won't hit these for a 6-15 person team)

| Service | Free Limit | Your usage |
|---|---|---|
| Vercel Hobby | 100 GB-hr/mo, 1M requests | <5% likely |
| Vercel Cron | 2 jobs (we use both) | OK |
| Gemini API | 2M tokens/day | <1% |
| Discord webhook | unlimited | OK |
| Gmail SMTP | 500 emails/day | OK |

---

## Folder Map

See `docs/00_overview.md` for full architecture diagram.
