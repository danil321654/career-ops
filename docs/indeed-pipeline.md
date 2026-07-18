# Indeed Job Discovery Pipeline

Discovery-only pipeline: searches Indeed in a Playwright MCP browser session, scores each job against your `cv.md` / `modes/_profile.md` with the standard career-ops 1–5 scoring, and files the results. It never applies (including "Easily apply"), messages, or submits anything. It shares its engine (`discover-core.mjs`) with the LinkedIn pipeline — see [linkedin-pipeline.md](linkedin-pipeline.md).

## Warning: Indeed Terms of Service

Automated browsing of Indeed violates Indeed's ToS and Indeed uses aggressive bot detection (Cloudflare). The mode stops immediately at any verification challenge and never bypasses it. Keep `max_jobs` small and runs infrequent; the risk is yours.

## Setup

1. **Playwright MCP server:** `claude mcp add playwright -- npx @playwright/mcp@latest` (or your CLI's equivalent).
2. **Authentication:** none needed for browsing. If Indeed shows a challenge page, complete it manually and re-run.
3. **Configuration:** add an `indeed:` block to `portals.yml` (commented example in `templates/portals.example.yml`):

```yaml
indeed:
  enabled: true
  query: "senior software engineer"
  location: "United States"        # default if omitted
  workplace_types: [remote]        # optional
  seniority: []                    # optional experience-level labels
  date_posted: "past_week"         # optional: past_24h | past_week | past_month
  max_jobs: 25                     # default 25
  minimum_mid_score: 2.5
  minimum_good_score: 3.5
```

## Running

Ask your agent: `/career-ops indeed`, or in words: *"run indeed discovery for data engineer, remote, 30 jobs"*. Conversation parameters override `portals.yml` for that run.

```bash
node indeed-discover.mjs config
node indeed-discover.mjs stats
```

## Scoring and thresholds

Same as the LinkedIn pipeline: the standard `modes/_shared.md` five-dimension score (1–5), computed compactly during discovery.

| Classification | Rule (defaults) | Destination |
|----------------|-----------------|-------------|
| good | score ≥ 3.5 | `data/indeed/good_matches.jsonl` + queued in `data/pipeline.md` for full A–G evaluation |
| mid | 2.5 < score < 3.5 | `data/indeed/mid_matches.jsonl` |
| irrelevant | score ≤ 2.5 | recorded (key + reason) in `data/indeed/processed_jobs.jsonl` only |

## Output files (all user layer, gitignored)

Same shapes as `data/linkedin/` — see [linkedin-pipeline.md](linkedin-pipeline.md). `processed_jobs.jsonl` is the resume state: interrupted runs rerun safely.

## Deduplication

Primary key: Indeed's hex job key (`jk=` / `vjk=` URL param, indeed.com hosts only). Fallback: normalized `company|title|location`. Sponsored re-listings of the same job collapse onto one key. Good matches are additionally URL-deduped and blacklist-gated before entering `data/pipeline.md`.

## Known limitations

- Cloudflare challenges stop the run; there is no bypass by design.
- Indeed salary figures are often estimates; they are recorded with an `estimated: ` prefix when Indeed labels them so.
- Relative posting dates ("3 days ago") are converted to approximate absolute dates.
- Layout changes stop the run with a diagnostic naming the missing element.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Indeed is showing a verification challenge" | Complete the check manually in the browser, re-run (or wait and retry later) |
| Run stopped with "layout change" diagnostic | Indeed changed its markup; re-run later or update `modes/indeed.md` selectors |
| Duplicate-looking rows in `pipeline.md` | `saveJob` already dedups by URL before appending; for dupes from other sources run `node dedup-tracker.mjs` |
| Helper errors | Re-run the failing `node indeed-discover.mjs ...` command with `--verbose` |
| Start over | Delete `data/indeed/` (loses resume state and results) |
