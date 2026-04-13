# GitHub Webhook → Auto-Assign (2 minutes)

This is what makes auto-assignment instant: every new issue triggers Vercel.

## Step 1: Generate a secret

Pick any random string. E.g.:
```
my-pm-bot-secret-2026-xyz
```

(Use https://passwordsgenerator.net for a strong one.)

## Step 2: Add to Vercel env

Vercel Dashboard → your project → **Settings** → **Environment Variables**
Add: `GITHUB_WEBHOOK_SECRET` = (your secret) → **Save** → **Redeploy**

## Step 3: Add webhook in GitHub

1. Go to your repo on GitHub
2. **Settings** → **Webhooks** → **Add webhook**
3. Fill in:
   - **Payload URL:** `https://your-pm.vercel.app/api/webhook`
   - **Content type:** `application/json`
   - **Secret:** (paste the same secret)
   - **SSL verification:** Enable
4. **Which events would you like to trigger this webhook?** → **Let me select individual events**
   - ✅ Issues
   - ✅ Pull requests
   - ✅ Pushes (optional, for activity logging)
5. **Active:** ✅
6. Click **Add webhook**

## Step 4: Test

In your repo → create a test issue:

**Title:** `[TASK] Test auto-assign — frontend payment`
**Body:** anything

Within 5 seconds:
- ✅ Issue gets assigned to your `frontend` or `payment` skilled dev (whoever is least loaded)
- ✅ Bot comment posted on issue: "Auto-assigned to @username"
- ✅ Discord #pm-reports gets a notification

## Verify webhook is connected

GitHub → repo → Settings → Webhooks → click your webhook → **Recent Deliveries** tab.

You should see the test event with status `200`. Click to see request/response.

If it failed:
- ❌ `401` → secret mismatch (re-check Vercel + GitHub match)
- ❌ `500` → check Vercel logs (Dashboard → project → Logs)
- ❌ `Connection refused` → wrong URL (typo or project not deployed)

## How the engine decides who to assign

See `05_auto_assign_rules.md` for full algorithm.

Short version:
1. Scans issue title/body/labels for skill keywords (e.g., `frontend`, `payment`)
2. Filters team to those with matching skills (from `TEAM_CONFIG` env)
3. Picks one with FEWEST currently-open issues
4. Assigns + announces in Discord

## Disable temporarily

GitHub → repo → Settings → Webhooks → click your webhook → toggle **Active** off.
Re-enable when you want.
