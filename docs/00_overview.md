# Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│              https://your-pm.vercel.app  (FREE)             │
│                                                             │
│   ┌─────────────┐    ┌─────────────────────────────────┐  │
│   │  Browser    │    │  Vercel Edge / Functions         │  │
│   │  Dashboard  │◄──►│  /api/github      /api/sheets    │  │
│   │ (HTML/CSS)  │    │  /api/assign      /api/webhook   │  │
│   └─────────────┘    │  /api/cron/daily  /api/cron/wkly │  │
│                      └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       GitHub API      Google Sheets       Discord Webhook
       (server-side    (public CSV         (post reports +
        token)          publish URL)        blocker alerts)

       Gmail SMTP                              Gemini AI
       (App Password)                          (free 2M tokens/day)
```

## Endpoints

| Path | Method | Purpose | Trigger |
|---|---|---|---|
| `/` | GET | Dashboard UI | User opens browser |
| `/api/github` | GET | Returns Kanban + metrics | Dashboard auto-refresh 30s |
| `/api/sheets` | GET | Returns Sheets rows | Sheets tab clicked |
| `/api/discord-info` | GET | Discord server ID for widget | Discord tab clicked |
| `/api/team-info` | GET | Team routing rules | Auto-Assign tab |
| `/api/assign?issue=N` | POST | Force-assign + announce | PM clicks "Assign", or webhook |
| `/api/webhook` | POST | GitHub webhook receiver | New issue/PR/label |
| `/api/cron/daily` | GET | Daily report → Discord+Email | Vercel cron 9 AM HKT |
| `/api/cron/weekly` | GET | Weekly report → Discord+Email | Vercel cron Fri 5 PM HKT |

## Data Flow Examples

### 1. PM opens dashboard
```
Browser → GET /  → static HTML
       → GET /api/github → Vercel function → GitHub API → JSON → render Kanban
       → setInterval(30s) → loop
```

### 2. Dev creates new issue
```
Dev → GitHub UI: New Issue
GitHub → POST /api/webhook (with X-Hub-Signature)
Vercel function:
  - verify HMAC signature
  - if action=opened & no assignee → call assignAndAnnounce()
  - assignAndAnnounce → analyze title for skills
                     → query GitHub for current load per dev
                     → pick least-loaded matching dev
                     → POST /repos/.../issues/N/assignees
                     → POST /repos/.../issues/N/comments (announce)
                     → post to Discord webhook
```

### 3. 9 AM weekday
```
Vercel Cron → GET /api/cron/daily
  - fetch metrics (24h window)
  - call Gemini for AI summary
  - POST to Discord webhook
  - send email via Gmail SMTP
```

## File Map

```
.
├── README.md                 ← top-level intro
├── package.json              ← Node.js deps (just nodemailer)
├── vercel.json               ← cron schedule + function config
├── .env.example              ← all env vars to set
├── .gitignore
│
├── public/                   ← static dashboard (served at /)
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── api/                      ← serverless functions
│   ├── github.js             ← GET → Kanban + metrics
│   ├── sheets.js             ← GET → CSV rows
│   ├── discord-info.js       ← GET → server ID
│   ├── team-info.js          ← GET → team routing
│   ├── assign.js             ← POST → assign & announce
│   ├── webhook.js            ← POST → GitHub webhook receiver
│   └── cron/
│       ├── daily.js          ← cron 9 AM
│       └── weekly.js         ← cron Fri 5 PM
│
├── lib/                      ← shared helpers
│   ├── github.js             ← API wrapper + getMetrics()
│   ├── sheets.js             ← CSV fetch + parser
│   ├── discord.js            ← post + makeEmbed
│   ├── ai.js                 ← Gemini / Claude wrapper
│   ├── email.js              ← nodemailer Gmail SMTP
│   └── assign.js             ← assignment algorithm
│
└── docs/                     ← setup guides (read in order)
    ├── 00_overview.md        ← this file
    ├── 01_deploy.md
    ├── 02_env_vars.md
    ├── 03_setup_google_sheets.md
    ├── 04_setup_github_webhook.md
    ├── 05_auto_assign_rules.md
    └── 06_discord_widget.md
```
