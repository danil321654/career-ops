# LinkedIn Job Discovery Pipeline

Discovery-only pipeline: searches LinkedIn Jobs in your own authenticated browser session (via the Playwright MCP server), scores each job against your `cv.md` / `modes/_profile.md` with the standard career-ops 1–5 scoring, and files the results. It never applies, messages, or submits anything.

## Warning: LinkedIn Terms of Service

Automated browsing of LinkedIn — even read-only, in your own session — violates LinkedIn's ToS and can lead to account restriction. Keep `max_jobs` small, keep runs infrequent, and understand the risk is yours. The mode never bypasses logins, captchas, checkpoints, or rate limits.

## Setup

1. **Playwright MCP server:** add it to your CLI (Claude Code example):
   `claude mcp add playwright -- npx @playwright/mcp@latest`
   The mode needs the browser tools (`browser_navigate`, `browser_snapshot`, click/type).
2. **Authentication:** open LinkedIn in the MCP browser once and log in manually. The mode detects login/checkpoint pages and stops with a message — it never enters credentials or solves challenges.
3. **Configuration:** add a `linkedin:` block to `portals.yml` (see the commented example in `templates/portals.example.yml`):

```yaml
linkedin:
  enabled: true
  query: "senior software engineer"
  location: "United States"        # default if omitted
  workplace_types: [remote]        # optional: remote | hybrid | onsite
  seniority: []                    # optional
  date_posted: "past_week"         # optional: past_24h | past_week | past_month
  max_jobs: 25                     # default 25
  minimum_mid_score: 2.5
  minimum_good_score: 3.5
```

## Running

Ask your agent: `/career-ops linkedin`, or in words: *"run linkedin discovery for staff platform engineer, remote, 50 jobs"*. Conversation parameters override `portals.yml` for that run. Inspect resolved config any time:

```bash
node linkedin-discover.mjs config
node linkedin-discover.mjs stats
```

## Scoring and thresholds

Each job gets the standard `modes/_shared.md` five-dimension score (1–5), computed compactly during discovery (no per-job web research, no report file). Classification:

| Classification | Rule (defaults) | Destination |
|----------------|-----------------|-------------|
| good | score ≥ 3.5 | `data/linkedin/good_matches.jsonl` + queued in `data/pipeline.md` for full A–G evaluation |
| mid | 2.5 < score < 3.5 | `data/linkedin/mid_matches.jsonl` |
| irrelevant | score ≤ 2.5 | recorded (id + reason) in `data/linkedin/processed_jobs.jsonl` only |

Thresholds are configurable via `minimum_mid_score` / `minimum_good_score`. Discovery classification is triage only — the standard "below 4.0, think twice before applying" guidance still applies at apply time.

## Output files (all user layer, gitignored)

- `data/linkedin/good_matches.jsonl` — full records: original JD text, normalized fields, score breakdown, matching reasons, missing requirements, concerns, timestamps.
- `data/linkedin/mid_matches.jsonl` — same shape.
- `data/linkedin/processed_jobs.jsonl` — every job ever seen (including irrelevant/error/closed) with score, classification, reason, and description hash. This is also the resume state: interrupted runs rerun safely, already-processed jobs are skipped, and a job is only re-scored when its description hash changes.

## Deduplication

Primary key: numeric LinkedIn job id (from the job URL). Fallback: normalized `company|title|location`. Reruns update records in place; nothing is duplicated or destroyed.

## Known limitations

- LinkedIn layout changes break extraction; the mode stops with a diagnostic naming the missing element rather than saving partial data.
- Relative posting dates ("2 weeks ago") are converted to approximate absolute dates.
- Salary, applicant count, and visa info are saved only when LinkedIn shows them.
- Search result ordering and counts are whatever LinkedIn serves your account.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "LinkedIn requires manual login" | Log in in the MCP browser window, re-run |
| Run stopped with "layout change" diagnostic | LinkedIn changed its markup; re-run later or update `modes/linkedin.md` selectors |
| Duplicate-looking rows in `pipeline.md` | `saveJob` already dedups by URL via `loadSeenUrls()` before appending, so reruns don't re-add a good match. If you see dupes from other sources, run `node dedup-tracker.mjs` |
| Helper errors | Re-run the failing `node linkedin-discover.mjs ...` command with `--verbose` |
| Start over | Delete `data/linkedin/` (this loses resume state and results) |
