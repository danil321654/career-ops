# Mode: linkedin — LinkedIn Job Discovery (Playwright MCP)

Discovers and classifies jobs on LinkedIn using the user's authenticated browser session via the Playwright MCP server. **Discovery and classification ONLY** — this mode NEVER applies to jobs, sends messages, connects, or submits anything, and NEVER bypasses captchas, checkpoints, rate limits, or access restrictions. If the user asks this mode to apply, refuse and point to the `apply` mode (human-in-the-loop).

**ToS note:** automated LinkedIn browsing violates LinkedIn's Terms of Service even when read-only in the user's own session. Keep runs small and slow; the account-restriction risk is the user's.

## Prerequisites

- Playwright MCP server connected (browser tools available).
- User logged in to LinkedIn in that browser.
- `cv.md` and `modes/_profile.md` exist (scoring inputs).

## Step 1 — Resolve configuration

Run: `node linkedin-discover.mjs config` and parse the JSON. Any parameters the user gave in conversation ("search staff platform engineer, remote, 50 jobs") override the config values for this run. If `query` is null after both sources, ask the user for one — never invent a query. If `enabled: false`, stop and say so.

## Step 2 — Auth gate

Navigate to `https://www.linkedin.com/jobs/`. Take a snapshot. If the page is a login form, a checkpoint/verification page, or a captcha:

> "LinkedIn requires manual login (or is showing a verification step). Please log in in the browser, then re-run this mode. I will not automate past login or security checks."

Stop immediately. Never enter credentials, never solve challenges.

## Step 3 — Search

Build the search from config: keywords = `query`, location = `location`, then apply available UI filters for `workplace_types`, `seniority`, `date_posted` when set. Prefer accessibility roles and stable labels ("Search by title, skill, or company", "City, state, or zip code", filter buttons) over CSS selectors. After applying filters, wait for the results list to settle (re-snapshot; retry once after a short wait on partial loads).

Report to the user: query, location, active filters, approximate result count shown by LinkedIn.

## Step 4 — Iterate results (up to max_jobs)

For each job card in the results list, oldest interaction pattern first: click the card to load the detail pane in the SAME tab (do not open new tabs; one detail view reused throughout).

Per job:

1. Get the job URL (address bar `currentJobId` or the card link) and compute nothing yourself — pass it to the helper.
2. Dedup gate: `node linkedin-discover.mjs check <jobId>`. If `found: false` → process the job. If `found: true` → count it as duplicate-skipped and move on WITHOUT opening the job detail. Exception — refresh pass: when the user explicitly asked to re-check known jobs this run, process found jobs anyway; `save` re-computes the description hash and updates the stored record in place, so unchanged jobs are harmless overwrites and changed jobs get a fresh score. (The `check --hash <sha256>` form exists for programmatic callers that already hold a description hash.)
3. Extract from the detail pane (expand "See more" first): title, company, company LinkedIn URL, job URL, location, workplace type, employment type, seniority level, salary range, date posted (convert relative dates like "2 weeks ago" to an absolute YYYY-MM-DD using today's date), applicant count, FULL original job description text, visible company info. Missing fields are simply absent — never invent values.
4. If the posting shows "No longer accepting applications" or the description pane is empty after retry: `node linkedin-discover.mjs mark --json '{"raw":{...}, "status":"closed"|"missing_jd", "reason":"..."}'` and continue.
5. If an expected structural element (results list, detail pane, description container) is missing from the snapshot: STOP the run with a diagnostic naming exactly which element/field was not found and on which page — LinkedIn layout likely changed. No silent partial results.
6. Wait 2–4 seconds between job opens (vary the delay).

Pagination: scroll the results list to load more cards; when a "next page" control exists, use it. Stop at `max_jobs`, when results are exhausted, or on a structural failure.

## Step 5 — Score each collected job (compact, NOT full A-G)

Load ONCE per run: `modes/_shared.md` § Scoring System, `cv.md`, `modes/_profile.md`, and targeting fields from `config/profile.yml`. For each job, score the five dimensions (Match con CV, North Star alignment, Comp, Cultural signals, Red flags) 1–5 and compute the weighted global score exactly as `_shared.md` defines. No WebSearch, no Blocks C–G, no report file, no tracker entry — this is discovery triage. Full A–G happens later via the `pipeline` mode for good matches.

Derive structured fields from the JD text while you read it: required_skills, preferred_skills, experience, education, visa_sponsorship (only when mentioned), technologies.

## Step 6 — Save

Per scored job:

```bash
node linkedin-discover.mjs save --json '{"raw":{...all collected fields...},"normalized":{...},"eval":{"score":4.1,"breakdown":{"cv_match":4,"north_star":4.5,"comp":4,"culture":4,"red_flags":"none"},"matching_reasons":[...],"missing_requirements":[...],"concerns":[...],"rejection_reason":"..."}}'
```

The helper classifies (good ≥ 3.5, 2.5 < mid < 3.5, irrelevant ≤ 2.5 — thresholds from config), routes to `data/linkedin/*.jsonl`, and appends good matches to `data/pipeline.md` + `data/scan-history.tsv`. Scoring failure (you cannot produce a valid 0–5 score) → `mark` with `status: "error"` and continue.

Save each job IMMEDIATELY after scoring it — this is what makes interrupted runs resumable (rerun; `check` skips completed jobs).

## Step 7 — Report

Run `node linkedin-discover.mjs stats`, then summarize: query, location, results discovered, jobs processed this run, good / mid / irrelevant counts, duplicates skipped, errors. Never print full job descriptions. Mention that good matches are queued in `data/pipeline.md` for full A–G evaluation via the `pipeline` mode.

## Error handling summary

| Condition | Action |
|-----------|--------|
| Login / checkpoint / captcha | Stop with message; never bypass |
| Nav timeout / partial load | One retry with delay; then `mark status=error`, continue |
| Closed posting / missing JD | `mark status=closed|missing_jd`, continue |
| Layout change (missing structural element) | Stop run with named-element diagnostic |
| Scoring failure | `mark status=error`, continue |
| Helper exits non-zero | Surface stderr to user, stop |
| Interrupted run | Rerun; processed jobs are skipped automatically |
