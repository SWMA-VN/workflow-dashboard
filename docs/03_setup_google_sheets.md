# Google Sheets → Dashboard (1 minute)

Use any Google Sheet — budget tracker, sprint plan, test results, anything — as a live data source on your dashboard.

## Step 1: Open your sheet

Open the Google Sheet you want to display.

## Step 2: Publish to web

1. Click **File** → **Share** → **Publish to web**
2. Tab: **Link**
3. Document type: dropdown → choose the specific sheet/tab
4. Format: **Comma-separated values (.csv)**
5. Click **Publish** → **OK**
6. Copy the URL — looks like:

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vXXXXXXXXXX/pub?gid=0&single=true&output=csv
```

## Step 3: Add to Vercel

1. Vercel Dashboard → your project → **Settings** → **Environment Variables**
2. Add: `GOOGLE_SHEETS_URL` = (paste URL)
3. **Save** → **Redeploy** (Deployments tab → ⋯ → Redeploy)

## Step 4: Verify

Open dashboard → click **📑 Sheets** tab → see your data.

---

## Important: only first row = header

The first row of your sheet becomes column headers. Make sure row 1 has clear names.

Good:
```
Task | Owner | Status | Due Date
TC-020 payment | Bob | Done | 2026-04-15
TC-090 hitpay | Alice | In progress | 2026-04-20
```

Bad:
```
"My Project Tracker"            ← merged header row, won't parse
Task | Owner | Status | Due
```

## Multiple sheets?

Currently the dashboard reads ONE sheet at a time. To rotate:
- Change the env var to a different sheet's URL → redeploy
- OR fork the dashboard tab to add multiple sources (1 hour code change)

## Privacy

- "Publish to web" makes the data **public** to anyone with the URL
- For sensitive data, use the Sheets API instead (requires service account, more setup)
- For a starter free setup, only publish data you're OK being public-but-obscure

---

## Bonus: keep a "PM Sheets" master tab

In your Google account, make a sheet `PM Live Data` with these tabs:
- Tab 1: Sprint Plan
- Tab 2: Budget vs Actuals
- Tab 3: Risk Register
- Tab 4: Stakeholder Contacts

Publish each tab as CSV → swap env var as needed.
Or just publish Tab 1 (most-used) — and view others in Notion/Drive directly.
