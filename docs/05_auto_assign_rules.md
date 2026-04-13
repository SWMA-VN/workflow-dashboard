# Auto-Assign Rules — How It Picks

Algorithm in `lib/assign.js`. Easy to tune.

## Decision Flow

```
┌────────────────────────────┐
│ New issue created          │
│ (no assignee)              │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ 1. Detect required skills  │
│ Scan title + body + labels │
│ for keywords like:         │
│   frontend, react, css     │
│   backend, api, db         │
│   payment, hitpay, fps     │
│   qa, test, bug            │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ 2. Filter team             │
│ Keep devs whose skills[]   │
│ intersect with required.   │
│ (No skills detected? Keep  │
│ everyone.)                 │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ 3. Filter by workload      │
│ Drop devs already at       │
│ max_open issues.           │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ 4. Pick least loaded       │
│ Sort by current open       │
│ count, ascending.          │
│ Tie-break alphabetical.    │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ 5. Assign + comment        │
│ POST GitHub assignees      │
│ Post bot comment           │
│ Post Discord embed         │
└────────────────────────────┘
```

## Skill Keyword Map

Defined in `lib/assign.js` (`SKILL_KEYWORDS`):

| Skill | Triggers if issue text contains |
|---|---|
| `frontend` | frontend, ui, ux, react, vue, css, html, tailwind, step-0, step-1, step-2, step-3 |
| `backend` | backend, api, server, database, db, sql, node, python, express, endpoint |
| `payment` | hitpay, wechat, fps, payment, stripe, checkout |
| `qa` | qa, test, test-case, tc-, bug |
| `devops` | devops, ci, cd, deploy, vercel, github-actions, docker |
| `integration` | bydesign, webhook, integration, third-party |

To add new skills (e.g., `mobile`): edit `lib/assign.js` → push → redeploy.

## TEAM_CONFIG Format

Env var, JSON string. Each dev:
- `skills`: array of skills they handle
- `max_open`: stop assigning when they hit this many open issues

```json
{
  "alice":  { "skills": ["frontend", "react"],          "max_open": 3 },
  "bob":    { "skills": ["backend", "payment"],         "max_open": 3 },
  "carol":  { "skills": ["qa"],                          "max_open": 5 },
  "dan":    { "skills": ["fullstack", "payment"],       "max_open": 3 },
  "eve":    { "skills": ["frontend"],                    "max_open": 3 },
  "frank":  { "skills": ["backend", "integration"],     "max_open": 3 }
}
```

**Tip:** add `"fullstack"` skill to your most flexible devs — they'll catch unmatched issues.

## Examples

### Issue: "Add HitPay drop-in modal to Step 2"
Detected skills: `payment` (from "hitpay"), `frontend` (from "step-2")
Eligible devs: anyone with `payment` OR `frontend`
Picked: least loaded among them.

### Issue: "Fix race condition in webhook"
Detected: `backend` (api), `integration` (webhook)
Eligible: backend or integration devs.

### Issue: "Update logo on landing page"
Detected: `frontend` (ui? actually no specific keywords)
If no match: falls back to ANY dev under `max_open`.

## Override Auto-Assign

PM can:
- **Re-assign manually** in GitHub UI (issue page → assignee dropdown)
- **Force re-pick** via dashboard → 🤖 Auto-Assign tab → "Assign for real"
- **Block engine** by adding `no-auto-assign` label to issue (todo: add to engine if you want this)

## Disable Auto-Assign Temporarily

Easy: edit `api/webhook.js` line that calls `assignAndAnnounce` → comment it out → push.
Or: turn off webhook in GitHub repo settings.

## Future improvements (you can ask me to add)

- Round-robin within tied workloads (instead of alphabetical)
- Time-of-day awareness (don't assign to people on night shift)
- Skill confidence scoring (matched 3 skills > matched 1)
- Slack/Teams in addition to Discord
- Manual override label `prefer:alice`
