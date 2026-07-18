# LinkedIn Job Discovery Pipeline — Design

**Date:** 2026-07-17
**Status:** Approved by user (brainstorming session)
**Scope:** Discovery and classification only. The pipeline never applies to jobs, never sends messages, never submits anything.

## Context

career-ops discovers jobs via `scan.mjs` + `providers/` (public, no-auth ATS APIs) and evaluates them with an LLM prompt system (`modes/_shared.md` scoring core + `modes/oferta.md` A–G blocks). Upstream doctrine keeps auth-gated sources out of core; this fork deliberately adds LinkedIn (auth-gated) as a first-class discovery source.

Two architectural constraints shape the design:

1. **Scoring is a prompt, not a function.** The 1–5 score comes from an LLM reading `modes/_shared.md` dimensions against `cv.md` / `modes/_profile.md`. There is no deterministic scoring function to import.
2. **Playwright MCP tools are agent-only.** `.mjs` scripts cannot call MCP tools. Browsing must live in an agent mode file; deterministic logic must live in a testable script.

**ToS caution (acknowledged):** automated LinkedIn browsing violates LinkedIn ToS even when read-only in the user's own session. The design is discovery-only, rate-limited, and never bypasses captchas, checkpoints, or rate limits. Account-restriction risk is accepted by the user.

## Decisions made

| Decision | Choice |
|----------|--------|
| Integration depth | **Hybrid** — JSONL sidecar files in `data/linkedin/`, plus good matches appended to `data/pipeline.md` and `data/scan-history.tsv` so existing downstream tooling (pipeline mode, repost detection, stats) sees them |
| Scoring execution | **Two-stage** — compact per-job scoring prompt during discovery (the `_shared.md` five dimensions, no Blocks C–G, no per-job WebSearch); full A–G evaluation later via the existing `pipeline` mode, on demand |
| Config location | `linkedin:` block in `portals.yml` (user layer, scan-config home) |
| Storage format | JSONL for LinkedIn-specific files (no existing career-ops JSONL convention to follow); existing markdown/TSV formats for the shared pipeline/scan-history writes |

## Components

### New files

| File | Layer | Role |
|------|-------|------|
| `modes/linkedin.md` | System | Agent-driven discovery mode. All Playwright MCP interaction: auth gate check, search, pagination/infinite scroll, job-detail extraction, compact scoring, progress reporting. |
| `linkedin-discover.mjs` | System | Deterministic helper CLI (subcommand style, like `update-system.mjs`). All testable logic. |
| `linkedin-discover.test.mjs` | System | Self-runner test suite (repo convention: pass/fail counters, exit code), registered in `test-all.mjs`. |
| `docs/linkedin-pipeline.md` | System | User documentation. |

### Edited files

- `AGENTS.md` — mode-table row + main-files table entries
- `DATA_CONTRACT.md` — `data/linkedin/*` registered as user layer
- `templates/portals.example.yml` — commented `linkedin:` example block
- `update-system.mjs` — new system files added to `SYSTEM_PATHS` (CI coverage guard enforces this)
- `test-all.mjs` — register the new test suite
- `.gitignore` — add `data/linkedin/` (the ignore list is per-file/per-dir, not a blanket `data/` rule)

### `linkedin-discover.mjs` subcommands

| Subcommand | Purpose |
|------------|---------|
| `config` | Read `portals.yml` `linkedin:` block, merge with defaults, print resolved JSON. |
| `check <jobId>` / `check --key <fallback-key>` | Dedup lookup against `processed_jobs.jsonl`. Prints JSON: `{found, changed, record?}` (caller passes description hash to detect changes). |
| `save --json '{...}'` | Validate + normalize a job record, classify by score, route to the correct output file(s), atomic append/update. For good matches, also append to `data/pipeline.md` and `data/scan-history.tsv`. |
| `stats` | Print run/lifetime counters (processed, good, mid, irrelevant, duplicates skipped, errors). |

Exported (and tested) functions: `classify(score, thresholds)`, `parseJobId(url)`, `fallbackKey(company, title, location)`, `normalizeJob(raw)`, `resolveConfig(yaml)`, plus the JSONL read/append/update helpers.

## Data flow

```
/career-ops linkedin  (or "run linkedin discovery for <query> ...")
  → node linkedin-discover.mjs config            resolved settings (chat args override yaml)
  → MCP: open linkedin.com/jobs                  auth gate check — stop with message if login needed
  → search with query / location / workplace / seniority / date-posted filters
  → per search result (up to max_jobs):
      node linkedin-discover.mjs check <jobId>   skip if processed and unchanged
      MCP: open job page, extract raw fields
      compact scoring prompt                     _shared.md dimensions + cv.md + _profile.md (loaded once per run)
      node linkedin-discover.mjs save --json …   classify + write
  → node linkedin-discover.mjs stats             summary table
```

## Configuration

`portals.yml`:

```yaml
linkedin:
  enabled: true
  query: "senior software engineer"     # no hardcoded default query — required via config or chat
  location: "United States"             # default when absent
  workplace_types: [remote]             # optional: remote | hybrid | onsite
  seniority: []                         # optional LinkedIn seniority filter values
  date_posted: "past_week"              # optional: past_24h | past_week | past_month
  max_jobs: 25                          # default 25, intended ceiling 100 (ToS-risk lever)
  minimum_mid_score: 2.5
  minimum_good_score: 3.5
```

Defaults hardcoded in `resolveConfig()`: `location: "United States"`, `minimum_good_score: 3.5`, `minimum_mid_score: 2.5`, `max_jobs: 25`. Conversation arguments always override yaml values for that run.

## Storage

All under `data/linkedin/` (user layer; added to `.gitignore` alongside the other personal-data entries):

- `good_matches.jsonl` — score ≥ `minimum_good_score` (default 3.5)
- `mid_matches.jsonl` — `minimum_mid_score` < score < `minimum_good_score` (default 2.5 < s < 3.5)
- `processed_jobs.jsonl` — every job ever seen: job id, fallback key, score, classification, rejection reason (for irrelevant), description hash, `collected_at`, `evaluated_at`. **This file is the resume state**: an interrupted run reruns and `check` skips completed jobs.

Classification boundaries (exact):

```
good:       score >= 3.5
mid:        2.5 < score < 3.5
irrelevant: score <= 2.5
```

Irrelevant jobs never enter the match files; they are recorded in `processed_jobs.jsonl` with a one-line rejection reason so they are never re-evaluated.

### Record schema (match files)

```json
{
  "id": "<linkedin job id>",
  "fallback_key": "<normalized company|title|location>",
  "raw": {
    "title": "...", "company": "...", "company_linkedin_url": "...",
    "job_url": "...", "location": "...", "workplace_type": "...",
    "employment_type": "...", "seniority": "...", "salary_range": "...",
    "date_posted": "...", "applicants": "...", "description": "<original full JD text>",
    "company_info": "..."
  },
  "normalized": {
    "required_skills": [], "preferred_skills": [], "experience": "...",
    "education": "...", "visa_sponsorship": "...", "technologies": []
  },
  "eval": {
    "score": 4.1,
    "breakdown": {"cv_match": 4, "north_star": 4.5, "comp": 4, "culture": 4, "red_flags": "..."},
    "matching_reasons": [], "missing_requirements": [], "concerns": [],
    "classification": "good", "evaluated_at": "<ISO timestamp>"
  },
  "collected_at": "<ISO timestamp>",
  "description_hash": "<sha256 of raw.description>"
}
```

Missing/unavailable fields are `null`, never fabricated.

### Hybrid writes (good matches only)

- `data/pipeline.md`: `- [ ] {job_url} | {Company} | {Title} | {Location} | posted: {date}` (existing format; dedup against existing lines)
- `data/scan-history.tsv`: row with `portal=linkedin` (existing columns)

### Write semantics

- Append-only JSONL; updates rewrite the file via temp-file + atomic rename (repo convention).
- Same job id seen again: description hash unchanged → skip; changed → re-score and update the record in place (single record per id, latest wins, `evaluated_at` refreshed).
- Reruns never destroy previous results.

## Deduplication

- **Primary key:** LinkedIn job id, parsed from the job URL (`parseJobId()` handles `/jobs/view/{id}`, `currentJobId={id}`, and tracking-parameter variants).
- **Fallback key** (id unavailable): `normalize(company)|normalize(title)|normalize(location)` — lowercase, trim, collapse internal whitespace, strip punctuation.

## Scoring (two-stage)

**Stage 1 — discovery triage (this feature):** one compact prompt per job inside the agent session. Inputs loaded once per run: `modes/_shared.md` scoring section, `cv.md`, `modes/_profile.md`, `config/profile.yml` targeting fields. Output per job: the five `_shared.md` dimensions scored 1–5, weighted global score, matching reasons, missing requirements, concerns. No Blocks C–G, no per-job WebSearch (cost control), no report file, no tracker entry.

**Stage 2 — full evaluation (existing, unchanged):** good matches land in `data/pipeline.md`; the user runs the existing `pipeline` / `oferta` flow whenever they want full A–G reports, PDFs, and tracker rows.

Classification is discovery triage only. The repo's downstream ethics rule ("below 4.0, discourage applying") is untouched.

## Error handling (encoded in `modes/linkedin.md`)

| Condition | Behavior |
|-----------|----------|
| Login page / checkpoint / captcha detected | Stop immediately with a clear message telling the user to log in manually. Never bypass. No data loss (every job is saved as soon as it is scored). |
| Navigation timeout / partial load | One retry with delay; on second failure record the job as `error` in `processed_jobs.jsonl` and continue. |
| Missing JD / closed or deleted posting | Record in `processed_jobs.jsonl` with reason; never enters match files. |
| Layout change (expected field absent from accessibility snapshot) | Fail the run with a diagnostic naming the missing field and page section. No silent partial results. |
| Scoring failure (malformed score) | Record as `error`, continue with next job. |
| File write failure | `save` exits non-zero with message; mode surfaces it and stops. |
| Interrupted run | Resumable by design: rerun, `check` skips processed jobs. |

Interaction hygiene: one job-detail tab reused throughout; 2–4 s delay between job opens; stable selectors / accessibility roles preferred; excessive tab creation avoided.

## Progress and logging

The mode reports during the run: query, location, results discovered, jobs processed, good/mid/irrelevant counts, duplicates skipped, errors. Full job descriptions never printed in normal output. `linkedin-discover.mjs --verbose` enables debug detail in the helper.

## Tests (`linkedin-discover.test.mjs`, zero live LinkedIn)

- Classification boundaries: 3.5 → good; 2.51 and 3.49 → mid; 2.5 and below → irrelevant; edges 0 and 5.
- Dedup by job id; fallback-key dedup; fallback-key normalization.
- Output separation: good vs mid vs processed routing.
- Config defaults: location `United States`, thresholds 3.5 / 2.5, `max_jobs` 25; yaml override behavior.
- `parseJobId()` against URL fixtures (view URLs, query-param URLs, tracking params, malformed).
- `normalizeJob()` against fixture JSON, including malformed and incomplete job pages (missing fields → null, no fabrication).
- Resume: partial `processed_jobs.jsonl` → rerun skips completed ids.
- Update-in-place: changed description hash → record updated, not duplicated.
- Atomic write behavior (temp + rename; no partial files on simulated failure).

## Out of scope

- Applying, messaging, connecting, or any submission on LinkedIn.
- Bypassing captchas, checkpoints, rate limits, or any access restriction.
- A standalone browser-automation framework (Playwright MCP only).
- Changes to the existing scoring system, tracker, or report formats.
- Recruiter/company enrichment beyond what the job page shows.
