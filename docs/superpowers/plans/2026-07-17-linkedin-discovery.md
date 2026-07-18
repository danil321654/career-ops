# LinkedIn Job Discovery Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discovery-only LinkedIn jobs pipeline: an agent mode (`modes/linkedin.md`) drives Playwright MCP browsing + compact scoring, and a deterministic helper (`linkedin-discover.mjs`) owns config, dedup, classification, JSONL storage, resume state, and hybrid writes into the existing pipeline.

**Architecture:** Two halves per the approved spec ([docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md](../specs/2026-07-17-linkedin-discovery-design.md)). The agent mode is the only place Playwright MCP tools are used (scripts cannot call MCP). Everything testable lives in `linkedin-discover.mjs`, which reuses `scan.mjs` exports (`appendToPipeline`, `appendToScanHistory`, `loadSeenUrls`) for the hybrid writes so LinkedIn good matches enter the existing pipeline/scan-history exactly like any other source.

**Tech Stack:** Node.js ESM (`.mjs`), `js-yaml` (already a dependency), `node:crypto` sha256, repo-convention self-runner tests (pass/fail counters, exit code), no new dependencies.

## Global Constraints

- Discovery and classification ONLY. No applying, messaging, connecting, or submitting anywhere. Never bypass captchas, checkpoints, rate limits, or access restrictions.
- Classification boundaries (exact): `good: score >= 3.5`, `mid: 2.5 < score < 3.5`, `irrelevant: score <= 2.5`. Thresholds configurable; these are the defaults.
- Default location: `"United States"`. Default `max_jobs: 25`. No hardcoded default query.
- Storage: JSONL under `data/linkedin/` (user layer, gitignored). Atomic writes (temp file + rename). Reruns never destroy previous results.
- Dedup: LinkedIn job id primary; fallback key = `normalize(company)|normalize(title)|normalize(location)`.
- Tests never touch live LinkedIn or the network.
- No new npm dependencies. Follow flat-root convention: script + its `.test.mjs` at repo root.
- Every new system file registered in `update-system.mjs` `SYSTEM_PATHS` (CI coverage guard enforces).
- Commit after each task. Code/comments/commits in normal English.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `linkedin-discover.mjs` | Create | All deterministic logic: config resolve, classify, job-id parse, fallback key, normalize, JSONL store, check/save/mark/stats CLI |
| `linkedin-discover.test.mjs` | Create | Self-runner suite for everything above |
| `modes/linkedin.md` | Create | Agent mode: MCP browsing, auth gate, extraction, compact scoring, error handling, progress |
| `docs/linkedin-pipeline.md` | Create | User documentation |
| `test-all.mjs` | Modify (~line 175) | Register new suite |
| `update-system.mjs` | Modify (SYSTEM_PATHS) | Register 3 new system files |
| `.gitignore` | Modify | Add `data/linkedin/` |
| `DATA_CONTRACT.md` | Modify | Register `data/linkedin/*` as user layer |
| `templates/portals.example.yml` | Modify | Commented `linkedin:` example block |
| `AGENTS.md` | Modify | Mode-table row + main-files rows |

---

### Task 1: Config resolution + classification (`resolveConfig`, `classify`)

**Files:**
- Create: `linkedin-discover.mjs`
- Create: `linkedin-discover.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS` (frozen object), `resolveConfig(yamlObj) -> config`, `classify(score, cfg) -> 'good'|'mid'|'irrelevant'`. Config keys: `enabled, query, location, workplace_types, seniority, date_posted, max_jobs, minimum_mid_score, minimum_good_score`.

- [ ] **Step 1: Write the failing tests**

Create `linkedin-discover.test.mjs`:

```js
/**
 * linkedin-discover.test.mjs — Test suite for linkedin-discover.mjs
 *
 * Run: node linkedin-discover.test.mjs
 * Convention: self-runner with pass/fail counters (see detect-reposts.test.mjs).
 * Never touches live LinkedIn or the network.
 */

import {
  DEFAULTS, resolveConfig, classify,
} from './linkedin-discover.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error(`FAIL: ${name}`); }
}

function assertThrows(fn, name) {
  try { fn(); failed++; failures.push(name); console.error(`FAIL (no throw): ${name}`); }
  catch { passed++; }
}

// ── resolveConfig ───────────────────────────────────────────────────

{
  const cfg = resolveConfig({});
  assert(cfg.location === 'United States', 'config: default location is United States');
  assert(cfg.minimum_good_score === 3.5, 'config: default good threshold 3.5');
  assert(cfg.minimum_mid_score === 2.5, 'config: default mid threshold 2.5');
  assert(cfg.max_jobs === 25, 'config: default max_jobs 25');
  assert(cfg.query === null, 'config: no default query');
  assert(cfg.enabled === true, 'config: enabled defaults true');
  assert(Array.isArray(cfg.workplace_types) && cfg.workplace_types.length === 0, 'config: workplace_types defaults []');
}

{
  const cfg = resolveConfig({ linkedin: { location: 'Berlin', max_jobs: 50, minimum_good_score: 4.0 } });
  assert(cfg.location === 'Berlin', 'config: yaml overrides location');
  assert(cfg.max_jobs === 50, 'config: yaml overrides max_jobs');
  assert(cfg.minimum_good_score === 4.0, 'config: yaml overrides good threshold');
  assert(cfg.minimum_mid_score === 2.5, 'config: unset keys keep defaults');
}

{
  const cfg = resolveConfig({ linkedin: { workplace_types: 'remote' } });
  assert(Array.isArray(cfg.workplace_types) && cfg.workplace_types[0] === 'remote',
    'config: bare-string workplace_types coerced to array');
}

assert(resolveConfig(null).location === 'United States', 'config: null yaml -> defaults');
assert(resolveConfig(undefined).location === 'United States', 'config: undefined yaml -> defaults');

assertThrows(() => resolveConfig({ linkedin: { minimum_good_score: 'high' } }), 'config: non-numeric threshold throws');
assertThrows(() => resolveConfig({ linkedin: { minimum_good_score: 7 } }), 'config: threshold > 5 throws');
assertThrows(() => resolveConfig({ linkedin: { minimum_mid_score: 4, minimum_good_score: 3 } }), 'config: mid >= good throws');
assertThrows(() => resolveConfig({ linkedin: { max_jobs: 0 } }), 'config: max_jobs < 1 throws');
assertThrows(() => resolveConfig({ linkedin: { max_jobs: 2.5 } }), 'config: non-integer max_jobs throws');

// ── classify ────────────────────────────────────────────────────────

assert(classify(3.5) === 'good', 'classify: 3.5 -> good (boundary)');
assert(classify(5) === 'good', 'classify: 5 -> good');
assert(classify(4.2) === 'good', 'classify: 4.2 -> good');
assert(classify(3.49) === 'mid', 'classify: 3.49 -> mid');
assert(classify(2.51) === 'mid', 'classify: 2.51 -> mid');
assert(classify(3.0) === 'mid', 'classify: 3.0 -> mid');
assert(classify(2.5) === 'irrelevant', 'classify: 2.5 -> irrelevant (boundary)');
assert(classify(0) === 'irrelevant', 'classify: 0 -> irrelevant');
assert(classify(1.9) === 'irrelevant', 'classify: 1.9 -> irrelevant');
assert(classify('4.1') === 'good', 'classify: numeric string accepted');

// custom thresholds
const strict = { minimum_mid_score: 3.0, minimum_good_score: 4.0 };
assert(classify(4.0, strict) === 'good', 'classify: custom good boundary');
assert(classify(3.5, strict) === 'mid', 'classify: custom mid band');
assert(classify(3.0, strict) === 'irrelevant', 'classify: custom irrelevant boundary');

assertThrows(() => classify(-1), 'classify: negative score throws');
assertThrows(() => classify(5.1), 'classify: score > 5 throws');
assertThrows(() => classify('n/a'), 'classify: non-numeric score throws');
assertThrows(() => classify(NaN), 'classify: NaN throws');

// ── summary ─────────────────────────────────────────────────────────

console.log(`\nlinkedin-discover tests: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `Cannot find module ... linkedin-discover.mjs`

- [ ] **Step 3: Write the implementation**

Create `linkedin-discover.mjs`:

```js
/**
 * linkedin-discover.mjs — Deterministic helper for the LinkedIn discovery mode
 * (modes/linkedin.md). The agent mode does all Playwright MCP browsing and
 * scoring; this script owns everything testable: config resolution,
 * score classification, dedup keys, JSONL storage, resume state, and the
 * hybrid writes into data/pipeline.md + data/scan-history.tsv.
 *
 * Subcommands:
 *   config                         print resolved linkedin config as JSON
 *   check <jobId> [--key K] [--hash H]   dedup lookup against processed_jobs.jsonl
 *   save --json '{...}'            classify + route a scored job record
 *   mark --json '{...}'            record an unscored job (error/closed/missing_jd/skipped)
 *   stats                          print lifetime counters as JSON
 *
 * Design spec: docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

export const DATA_DIR = 'data/linkedin';
export const GOOD_PATH = join(DATA_DIR, 'good_matches.jsonl');
export const MID_PATH = join(DATA_DIR, 'mid_matches.jsonl');
export const PROCESSED_PATH = join(DATA_DIR, 'processed_jobs.jsonl');
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

// ── Config ──────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  enabled: true,
  query: null,
  location: 'United States',
  workplace_types: Object.freeze([]),
  seniority: Object.freeze([]),
  date_posted: null,
  max_jobs: 25,
  minimum_mid_score: 2.5,
  minimum_good_score: 3.5,
});

export function resolveConfig(yamlObj) {
  const block = (yamlObj && typeof yamlObj === 'object' && yamlObj.linkedin
    && typeof yamlObj.linkedin === 'object') ? yamlObj.linkedin : {};
  const cfg = { ...DEFAULTS, ...block };

  for (const k of ['minimum_mid_score', 'minimum_good_score']) {
    const v = Number(cfg[k]);
    if (!Number.isFinite(v) || v < 0 || v > 5) {
      throw new Error(`linkedin.${k} must be a number between 0 and 5, got: ${JSON.stringify(cfg[k])}`);
    }
    cfg[k] = v;
  }
  if (cfg.minimum_mid_score >= cfg.minimum_good_score) {
    throw new Error(`linkedin.minimum_mid_score (${cfg.minimum_mid_score}) must be below linkedin.minimum_good_score (${cfg.minimum_good_score})`);
  }

  const mj = Number(cfg.max_jobs);
  if (!Number.isInteger(mj) || mj < 1) {
    throw new Error(`linkedin.max_jobs must be a positive integer, got: ${JSON.stringify(cfg.max_jobs)}`);
  }
  cfg.max_jobs = mj;

  for (const k of ['workplace_types', 'seniority']) {
    if (typeof cfg[k] === 'string') cfg[k] = [cfg[k]];
    if (!Array.isArray(cfg[k])) cfg[k] = [];
  }

  return cfg;
}

// ── Classification ──────────────────────────────────────────────────

export function classify(score, cfg = DEFAULTS) {
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0 || s > 5) {
    throw new Error(`score must be a number between 0 and 5, got: ${JSON.stringify(score)}`);
  }
  if (s >= cfg.minimum_good_score) return 'good';
  if (s > cfg.minimum_mid_score) return 'mid';
  return 'irrelevant';
}

// ── CLI ─────────────────────────────────────────────────────────────

function usage() {
  console.error('Usage: node linkedin-discover.mjs <config|check|save|mark|stats> [args]');
  process.exit(2);
}

async function main() {
  const [cmd] = process.argv.slice(2);
  try {
    if (cmd === 'config') {
      const yamlObj = existsSync(PORTALS_PATH)
        ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))
        : {};
      console.log(JSON.stringify(resolveConfig(yamlObj), null, 2));
    } else {
      usage();
    }
  } catch (err) {
    console.error(`linkedin-discover: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

(Unused imports `writeFileSync`, `createHash`, `dirname`, `mkdirSync`, `renameSync` are used by Tasks 3–4; keep them.)

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS — all config + classify assertions, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add linkedin-discover config resolution and score classification"
```

---

### Task 2: Dedup keys (`parseJobId`, `normalizeField`, `fallbackKey`)

**Files:**
- Modify: `linkedin-discover.mjs`
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Produces: `parseJobId(url) -> string|null`, `normalizeField(value) -> string`, `fallbackKey(company, title, location) -> string` (pipe-joined normalized fields).

- [ ] **Step 1: Add failing tests**

In `linkedin-discover.test.mjs`, extend the import and add before the summary block:

```js
// add to the import list at top:
//   parseJobId, normalizeField, fallbackKey,

// ── parseJobId ──────────────────────────────────────────────────────

assert(parseJobId('https://www.linkedin.com/jobs/view/4012345678/') === '4012345678',
  'parseJobId: plain view URL');
assert(parseJobId('https://www.linkedin.com/jobs/view/senior-engineer-at-acme-4012345678') === '4012345678',
  'parseJobId: slug view URL');
assert(parseJobId('https://www.linkedin.com/jobs/view/4012345678?refId=abc&trackingId=xyz') === '4012345678',
  'parseJobId: view URL with tracking params');
assert(parseJobId('https://www.linkedin.com/jobs/search/?currentJobId=4098765432&keywords=engineer') === '4098765432',
  'parseJobId: currentJobId query param');
assert(parseJobId('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4011111111') === '4011111111',
  'parseJobId: collections URL with currentJobId');
assert(parseJobId('https://example.com/careers/123') === null, 'parseJobId: non-linkedin URL -> null');
assert(parseJobId('https://www.linkedin.com/jobs/search/?keywords=engineer') === null,
  'parseJobId: search URL without job id -> null');
assert(parseJobId(null) === null, 'parseJobId: null -> null');
assert(parseJobId(42) === null, 'parseJobId: non-string -> null');

// ── fallbackKey ─────────────────────────────────────────────────────

assert(normalizeField('  Acme,  Corp.  ') === 'acme corp', 'normalizeField: punctuation stripped, whitespace collapsed');
assert(normalizeField('Señor Engineer') === 'señor engineer', 'normalizeField: unicode letters preserved');
assert(normalizeField(null) === '', 'normalizeField: null -> empty string');

assert(fallbackKey('Acme Corp.', 'Senior Engineer', 'New York, NY')
  === 'acme corp|senior engineer|new york ny', 'fallbackKey: normalized pipe-joined');
assert(fallbackKey('ACME corp', 'senior   engineer', 'new york. ny')
  === fallbackKey('Acme Corp.', 'Senior Engineer', 'New York, NY'),
  'fallbackKey: case/punctuation/whitespace variants collide (that is the point)');
assert(fallbackKey(null, 'Engineer', null) === '|engineer|', 'fallbackKey: missing fields stay positional');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `parseJobId` not exported

- [ ] **Step 3: Implement**

Add to `linkedin-discover.mjs` after the classification section:

```js
// ── Dedup keys ──────────────────────────────────────────────────────

// LinkedIn job URLs carry the numeric job id either in the path
// (/jobs/view/{id} or /jobs/view/{slug}-{id}) or as ?currentJobId={id}.
export function parseJobId(url) {
  if (typeof url !== 'string') return null;
  const view = url.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/);
  if (view) return view[1];
  const param = url.match(/[?&]currentJobId=(\d{6,})/);
  if (param) return param[1];
  return null;
}

export function normalizeField(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fallback dedup key when the job id is unavailable.
export function fallbackKey(company, title, location) {
  return [company, title, location].map(normalizeField).join('|');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add linkedin job-id parsing and fallback dedup key"
```

---

### Task 3: Record normalization (`normalizeJob`, `descriptionHash`, `parsePostedAt`)

**Files:**
- Modify: `linkedin-discover.mjs`
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Produces: `normalizeJob(input) -> record` with shape `{id, fallback_key, raw{13 fields}, normalized{6 fields}, eval, collected_at, description_hash}`; `descriptionHash(text) -> sha256 hex`; `parsePostedAt(datePosted) -> epochMs|undefined`. Missing fields become `null`, never fabricated. Throws on a malformed page (no id AND no company AND no title).

- [ ] **Step 1: Add failing tests**

Extend imports (`normalizeJob, descriptionHash, parsePostedAt, RAW_FIELDS, NORMALIZED_FIELDS`) and add:

```js
// ── normalizeJob ────────────────────────────────────────────────────

const FULL_JOB = {
  raw: {
    title: 'Senior Backend Engineer',
    company: 'Acme Corp',
    company_linkedin_url: 'https://www.linkedin.com/company/acme',
    job_url: 'https://www.linkedin.com/jobs/view/4012345678/',
    location: 'United States (Remote)',
    workplace_type: 'Remote',
    employment_type: 'Full-time',
    seniority: 'Senior',
    salary_range: '$150K - $190K',
    date_posted: '2026-07-10',
    applicants: '57',
    description: 'We are looking for a senior backend engineer...',
    company_info: 'Acme builds infrastructure. 500 employees.',
  },
  normalized: {
    required_skills: ['Go', 'PostgreSQL'],
    preferred_skills: ['Kubernetes'],
    experience: '5+ years backend',
    education: null,
    visa_sponsorship: 'not mentioned',
    technologies: ['Go', 'PostgreSQL', 'Kubernetes', 'AWS'],
  },
};

{
  const rec = normalizeJob(FULL_JOB);
  assert(rec.id === '4012345678', 'normalizeJob: id parsed from job_url');
  assert(rec.fallback_key === 'acme corp|senior backend engineer|united states remote',
    'normalizeJob: fallback_key computed');
  assert(rec.raw.title === 'Senior Backend Engineer', 'normalizeJob: raw fields preserved');
  assert(rec.raw.description === FULL_JOB.raw.description, 'normalizeJob: original description preserved');
  assert(rec.normalized.required_skills.length === 2, 'normalizeJob: normalized fields preserved');
  assert(typeof rec.description_hash === 'string' && rec.description_hash.length === 64,
    'normalizeJob: sha256 description hash');
  assert(typeof rec.collected_at === 'string' && !Number.isNaN(Date.parse(rec.collected_at)),
    'normalizeJob: collected_at is a valid ISO timestamp');
  assert(rec.eval === null, 'normalizeJob: eval null when absent');
}

{
  // Incomplete page: missing fields become null, never invented.
  const rec = normalizeJob({ raw: { title: 'Engineer', company: 'Acme', job_url: 'https://www.linkedin.com/jobs/view/4000000001/' } });
  assert(rec.raw.salary_range === null, 'normalizeJob: missing salary -> null');
  assert(rec.raw.description === null, 'normalizeJob: missing description -> null');
  assert(rec.normalized.required_skills === null, 'normalizeJob: missing normalized field -> null');
  assert(rec.description_hash === descriptionHash(''), 'normalizeJob: hash of empty description is stable');
}

{
  // Explicit id wins over URL parsing; fallback key works without id.
  const rec = normalizeJob({ id: '999999999', raw: { title: 'Engineer', company: 'Acme' } });
  assert(rec.id === '999999999', 'normalizeJob: explicit id preserved');
  const noId = normalizeJob({ raw: { title: 'Engineer', company: 'Acme', location: 'Berlin' } });
  assert(noId.id === null && noId.fallback_key === 'acme|engineer|berlin',
    'normalizeJob: no id -> null id + usable fallback key');
}

assertThrows(() => normalizeJob(null), 'normalizeJob: null input throws');
assertThrows(() => normalizeJob({ raw: { applicants: '5' } }),
  'normalizeJob: malformed page (no id/company/title) throws');

assert(descriptionHash('abc') === descriptionHash('abc'), 'descriptionHash: deterministic');
assert(descriptionHash('abc') !== descriptionHash('abd'), 'descriptionHash: sensitive to change');

assert(parsePostedAt('2026-07-10') === Date.parse('2026-07-10T00:00:00Z'), 'parsePostedAt: ISO date');
assert(parsePostedAt('2 weeks ago') === undefined, 'parsePostedAt: relative date -> undefined');
assert(parsePostedAt(null) === undefined, 'parsePostedAt: null -> undefined');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `normalizeJob` not exported

- [ ] **Step 3: Implement**

Add to `linkedin-discover.mjs`:

```js
// ── Record normalization ────────────────────────────────────────────

export const RAW_FIELDS = Object.freeze([
  'title', 'company', 'company_linkedin_url', 'job_url', 'location',
  'workplace_type', 'employment_type', 'seniority', 'salary_range',
  'date_posted', 'applicants', 'description', 'company_info',
]);

export const NORMALIZED_FIELDS = Object.freeze([
  'required_skills', 'preferred_skills', 'experience', 'education',
  'visa_sponsorship', 'technologies',
]);

export function descriptionHash(description) {
  return createHash('sha256').update(String(description ?? ''), 'utf-8').digest('hex');
}

// LinkedIn shows either an absolute date or a relative one ("2 weeks ago").
// Only absolute YYYY-MM-DD dates convert to epoch ms; anything else is undefined
// so the pipeline line simply omits the posted: segment.
export function parsePostedAt(datePosted) {
  if (typeof datePosted !== 'string') return undefined;
  const m = datePosted.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(t) ? t : undefined;
}

function pickFields(source, fields) {
  const out = {};
  for (const f of fields) {
    const v = source?.[f];
    out[f] = (v === undefined || v === null || v === '') ? null : v;
  }
  return out;
}

export function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('normalizeJob: input must be an object');
  }
  const raw = pickFields(input.raw ?? input, RAW_FIELDS);
  const normalized = pickFields(input.normalized ?? {}, NORMALIZED_FIELDS);

  const id = input.id ?? parseJobId(raw.job_url ?? '');
  if (!id && raw.company === null && raw.title === null) {
    const present = RAW_FIELDS.filter(f => raw[f] !== null);
    throw new Error(
      `normalizeJob: malformed job page — no job id, no company, no title. Fields present: ${present.join(', ') || '(none)'}`,
    );
  }

  return {
    id: id ?? null,
    fallback_key: fallbackKey(raw.company, raw.title, raw.location),
    raw,
    normalized,
    eval: input.eval ?? null,
    collected_at: input.collected_at ?? new Date().toISOString(),
    description_hash: descriptionHash(raw.description),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add linkedin job record normalization with null-safe fields"
```

---

### Task 4: JSONL store (atomic read/upsert/remove)

**Files:**
- Modify: `linkedin-discover.mjs`
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Produces: `readJsonl(path) -> record[]`, `writeJsonlAtomic(path, records)`, `recordKey(record) -> string` (id, else fallback_key), `upsertJsonl(path, record) -> 'inserted'|'updated'`, `removeFromJsonl(path, key)`.

- [ ] **Step 1: Add failing tests**

Extend imports (`readJsonl, writeJsonlAtomic, upsertJsonl, removeFromJsonl, recordKey`) plus at the top of the test file:

```js
import { mkdtempSync, rmSync, readFileSync as rf, writeFileSync as wf, existsSync as ex, readdirSync } from 'fs';
import { join as pjoin } from 'path';
import { tmpdir } from 'os';
```

Add tests:

```js
// ── JSONL store ─────────────────────────────────────────────────────

{
  const dir = mkdtempSync(pjoin(tmpdir(), 'li-jsonl-'));
  const file = pjoin(dir, 'x.jsonl');

  assert(readJsonl(file).length === 0, 'jsonl: missing file -> empty array');

  const a = { id: '1', fallback_key: 'a|x|us', v: 1 };
  const b = { id: '2', fallback_key: 'b|y|us', v: 1 };
  assert(upsertJsonl(file, a) === 'inserted', 'jsonl: first upsert inserts');
  assert(upsertJsonl(file, b) === 'inserted', 'jsonl: second upsert inserts');
  assert(readJsonl(file).length === 2, 'jsonl: two records persisted');

  assert(upsertJsonl(file, { ...a, v: 2 }) === 'updated', 'jsonl: same id updates in place');
  const rows = readJsonl(file);
  assert(rows.length === 2 && rows.find(r => r.id === '1').v === 2, 'jsonl: update replaced, not duplicated');

  // key precedence: id else fallback_key
  assert(recordKey({ id: '9', fallback_key: 'k' }) === '9', 'recordKey: id wins');
  assert(recordKey({ id: null, fallback_key: 'k' }) === 'k', 'recordKey: fallback when no id');

  // fallback-key dedup (no id on either record)
  const c = { id: null, fallback_key: 'acme|engineer|berlin', v: 1 };
  upsertJsonl(file, c);
  upsertJsonl(file, { ...c, v: 2 });
  const cRows = readJsonl(file).filter(r => r.fallback_key === 'acme|engineer|berlin');
  assert(cRows.length === 1 && cRows[0].v === 2, 'jsonl: fallback-key dedup updates in place');

  removeFromJsonl(file, '2');
  assert(readJsonl(file).find(r => r.id === '2') === undefined, 'jsonl: remove by key');

  // atomic write: no .tmp file left behind
  assert(readdirSync(dir).every(f => !f.endsWith('.tmp')), 'jsonl: no temp files left after writes');

  // malformed line -> loud error with path and line number
  wf(file, '{"ok":1}\nnot json\n', 'utf-8');
  assertThrows(() => readJsonl(file), 'jsonl: malformed line throws');

  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `readJsonl` not exported

- [ ] **Step 3: Implement**

Add to `linkedin-discover.mjs`:

```js
// ── JSONL store ─────────────────────────────────────────────────────
// Files are canonical (repo doctrine). Rewrites go through a temp file +
// atomic rename so an interrupted run never leaves a partial file.

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`${path}:${i + 1}: malformed JSONL line`); }
    });
}

export function writeJsonlAtomic(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = records.map(r => JSON.stringify(r)).join('\n');
  writeFileSync(tmp, body ? `${body}\n` : '', 'utf-8');
  renameSync(tmp, path);
}

export function recordKey(record) {
  return record.id ?? record.fallback_key;
}

export function upsertJsonl(path, record) {
  const rows = readJsonl(path);
  const key = recordKey(record);
  const idx = rows.findIndex(r => recordKey(r) === key);
  if (idx === -1) rows.push(record);
  else rows[idx] = record;
  writeJsonlAtomic(path, rows);
  return idx === -1 ? 'inserted' : 'updated';
}

export function removeFromJsonl(path, key) {
  const rows = readJsonl(path);
  const next = rows.filter(r => recordKey(r) !== key);
  if (next.length !== rows.length) writeJsonlAtomic(path, next);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add atomic JSONL store with id/fallback-key upsert"
```

---

### Task 5: Dedup check + unscored marks (`checkJob`, `markJob`)

**Files:**
- Modify: `linkedin-discover.mjs`
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Consumes: `readJsonl`, `upsertJsonl`, `normalizeJob`, `recordKey` (Tasks 3–4).
- Produces: `checkJob({id, key, hash}, processedPath) -> {found, changed, record?}`; `markJob(input, processedPath) -> processedEntry` where `input.status ∈ {'error','closed','missing_jd','skipped'}`. Processed-entry shape: `{id, fallback_key, title, company, score, classification, reason, description_hash, collected_at, evaluated_at}`.

- [ ] **Step 1: Add failing tests**

Extend imports (`checkJob, markJob`) and add:

```js
// ── checkJob / markJob ──────────────────────────────────────────────

{
  const dir = mkdtempSync(pjoin(tmpdir(), 'li-check-'));
  const processed = pjoin(dir, 'processed_jobs.jsonl');

  assert(checkJob({ id: '4012345678' }, processed).found === false, 'check: empty state -> not found');

  markJob({ raw: { title: 'Gone Role', company: 'Acme', job_url: 'https://www.linkedin.com/jobs/view/4012345678/' }, status: 'closed', reason: 'No longer accepting applications' }, processed);

  const hit = checkJob({ id: '4012345678' }, processed);
  assert(hit.found === true, 'check: marked job found by id');
  assert(hit.record.classification === 'closed', 'check: mark status recorded as classification');
  assert(hit.record.reason === 'No longer accepting applications', 'check: mark reason recorded');
  assert(hit.record.score === null, 'check: marked job has null score');

  // change detection via description hash
  const sameHash = hit.record.description_hash;
  assert(checkJob({ id: '4012345678', hash: sameHash }, processed).changed === false,
    'check: same hash -> unchanged');
  assert(checkJob({ id: '4012345678', hash: 'deadbeef' }, processed).changed === true,
    'check: different hash -> changed');
  assert(checkJob({ id: '4012345678' }, processed).changed === false,
    'check: no hash provided -> not flagged changed');

  // fallback-key lookup
  markJob({ raw: { title: 'NoId Role', company: 'Beta', location: 'Berlin' }, status: 'error', reason: 'navigation timeout' }, processed);
  assert(checkJob({ key: 'beta|noid role|berlin' }, processed).found === true,
    'check: found by fallback key');

  assertThrows(() => markJob({ raw: { title: 'X', company: 'Y' }, status: 'nonsense' }, processed),
    'mark: unknown status throws');

  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `checkJob` not exported

- [ ] **Step 3: Implement**

Add to `linkedin-discover.mjs`:

```js
// ── Dedup check + unscored marks ────────────────────────────────────

export function checkJob({ id, key, hash } = {}, processedPath = PROCESSED_PATH) {
  const rows = readJsonl(processedPath);
  const record = rows.find(r =>
    (id != null && r.id === id) || (key != null && r.fallback_key === key));
  if (!record) return { found: false, changed: false };
  const changed = hash != null && record.description_hash !== hash;
  return { found: true, changed, record };
}

export const MARK_STATUSES = Object.freeze(['error', 'closed', 'missing_jd', 'skipped']);

// Record a job that could not be scored (dead posting, missing JD, nav error)
// so reruns never re-process it. Distinct from saveJob, which requires a score.
export function markJob(input, processedPath = PROCESSED_PATH) {
  const status = input?.status;
  if (!MARK_STATUSES.includes(status)) {
    throw new Error(`markJob: status must be one of ${MARK_STATUSES.join('|')}, got: ${JSON.stringify(status)}`);
  }
  const record = normalizeJob(input);
  const entry = {
    id: record.id,
    fallback_key: record.fallback_key,
    title: record.raw.title,
    company: record.raw.company,
    score: null,
    classification: status,
    reason: input.reason ?? null,
    description_hash: record.description_hash,
    collected_at: record.collected_at,
    evaluated_at: null,
  };
  upsertJsonl(processedPath, entry);
  return entry;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add dedup check with change detection and unscored job marks"
```

---

### Task 6: Save + routing + hybrid pipeline writes (`saveJob`, `computeStats`)

**Files:**
- Modify: `linkedin-discover.mjs`
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Consumes: `classify`, `normalizeJob`, JSONL store, `checkJob`, `parsePostedAt`; from `scan.mjs`: `appendToPipeline(offers)`, `appendToScanHistory(offers, date, status)`, `loadSeenUrls()` (offer shape: `{url, company, title, location, source, postedAt, description}`).
- Produces: `saveJob(input, cfg, paths?) -> {classification, action, pipelined, id, key}` (async); `computeStats(paths?) -> {processed, good, mid, irrelevant, errors}`. `paths` override `{good, mid, processed}` for tests; hybrid writes use `scan.mjs` cwd-relative paths (tests `process.chdir` into a temp dir).

- [ ] **Step 1: Add failing tests**

Extend imports (`saveJob, computeStats, GOOD_PATH, MID_PATH, PROCESSED_PATH`) and add:

```js
// ── saveJob routing + hybrid writes + resume ────────────────────────

{
  // saveJob calls scan.mjs appendToPipeline/appendToScanHistory, which write
  // cwd-relative data/ paths — run this block inside a temp cwd.
  const dir = mkdtempSync(pjoin(tmpdir(), 'li-save-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const cfg = { minimum_mid_score: 2.5, minimum_good_score: 3.5 };
    const mkJob = (id, score, over = {}) => ({
      raw: {
        title: over.title ?? 'Senior Backend Engineer',
        company: over.company ?? 'Acme Corp',
        job_url: `https://www.linkedin.com/jobs/view/${id}/`,
        location: 'United States (Remote)',
        date_posted: '2026-07-10',
        description: over.description ?? `JD body for ${id}`,
      },
      eval: {
        score,
        breakdown: { cv_match: score, north_star: score, comp: score, culture: score, red_flags: 'none' },
        matching_reasons: ['strong backend match'],
        missing_requirements: [],
        concerns: [],
      },
    });

    // routing: good
    const g = await saveJob(mkJob('4000000001', 4.2), cfg);
    assert(g.classification === 'good' && g.action === 'inserted', 'save: 4.2 -> good inserted');
    assert(readJsonl(GOOD_PATH).length === 1, 'save: good match in good_matches.jsonl');
    assert(readJsonl(MID_PATH).length === 0, 'save: good match NOT in mid file');
    assert(readJsonl(GOOD_PATH)[0].eval.classification === 'good', 'save: classification stamped on record');
    assert(typeof readJsonl(GOOD_PATH)[0].eval.evaluated_at === 'string', 'save: evaluated_at stamped');

    // hybrid: good match appended to pipeline.md + scan-history.tsv
    assert(g.pipelined === true, 'save: good match pipelined');
    assert(rf('data/pipeline.md', 'utf-8').includes('4000000001'), 'save: pipeline.md has job URL');
    const hist = rf('data/scan-history.tsv', 'utf-8');
    assert(hist.includes('linkedin') && hist.includes('4000000001'), 'save: scan-history row with portal=linkedin');

    // rerun same unchanged job -> update, no pipeline duplicate
    const g2 = await saveJob(mkJob('4000000001', 4.2), cfg);
    assert(g2.action === 'updated' && g2.pipelined === false, 'save: rerun updates without re-pipelining');
    assert(readJsonl(GOOD_PATH).length === 1, 'save: rerun does not duplicate good match');
    assert((rf('data/pipeline.md', 'utf-8').match(/4000000001/g) || []).length === 1,
      'save: pipeline.md not duplicated on rerun');

    // routing: mid
    const m = await saveJob(mkJob('4000000002', 3.0), cfg);
    assert(m.classification === 'mid' && m.pipelined === false, 'save: 3.0 -> mid, not pipelined');
    assert(readJsonl(MID_PATH).length === 1, 'save: mid match in mid_matches.jsonl');

    // routing: irrelevant — processed only, with reason
    const i = await saveJob({ ...mkJob('4000000003', 2.0), eval: { ...mkJob('4000000003', 2.0).eval, rejection_reason: 'wrong stack' } }, cfg);
    assert(i.classification === 'irrelevant', 'save: 2.0 -> irrelevant');
    assert(readJsonl(GOOD_PATH).length === 1 && readJsonl(MID_PATH).length === 1,
      'save: irrelevant not in match files');
    const proc3 = readJsonl(PROCESSED_PATH).find(r => r.id === '4000000003');
    assert(proc3 && proc3.reason === 'wrong stack', 'save: irrelevant recorded with rejection reason');

    // reclassification: changed JD re-scored mid -> good moves files
    await saveJob(mkJob('4000000002', 3.8, { description: 'updated JD body' }), cfg);
    assert(readJsonl(MID_PATH).length === 0, 'save: reclassified job removed from mid file');
    assert(readJsonl(GOOD_PATH).some(r => r.id === '4000000002'), 'save: reclassified job now in good file');

    // resume semantics: processed file is the state
    assert(checkJob({ id: '4000000003' }, PROCESSED_PATH).found === true,
      'resume: processed job found on rerun (skip)');
    assert(checkJob({ id: '4000000099' }, PROCESSED_PATH).found === false,
      'resume: unseen job not found (process it)');

    // missing score throws
    let threw = false;
    try { await saveJob({ raw: { title: 'X', company: 'Y' } }, cfg); } catch { threw = true; }
    assert(threw, 'save: missing eval.score throws');

    // stats
    const s = computeStats();
    assert(s.processed === 3 && s.good === 2 && s.mid === 0 && s.irrelevant === 1,
      `stats: counts correct (got ${JSON.stringify(s)})`);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Note: the test file's top-level `await` works because `.mjs` modules support it. Wrap this block in an async IIFE only if a syntax error appears — prefer top-level await.

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `saveJob` not exported

- [ ] **Step 3: Implement**

Add to `linkedin-discover.mjs`:

```js
// ── Save + routing ──────────────────────────────────────────────────

function summarizeReason(record) {
  const missing = record.eval?.missing_requirements ?? [];
  if (missing.length) return `missing: ${missing.slice(0, 3).join(', ')}`;
  return 'below relevance threshold';
}

export async function saveJob(input, cfg = DEFAULTS, paths = {}) {
  const goodPath = paths.good ?? GOOD_PATH;
  const midPath = paths.mid ?? MID_PATH;
  const processedPath = paths.processed ?? PROCESSED_PATH;

  const record = normalizeJob(input);
  if (record.eval == null || record.eval.score == null) {
    throw new Error('saveJob: record.eval.score is required (use `mark` for unscored jobs)');
  }
  const classification = classify(record.eval.score, cfg);
  record.eval.classification = classification;
  record.eval.evaluated_at = record.eval.evaluated_at ?? new Date().toISOString();

  const key = recordKey(record);
  const prev = checkJob({ id: record.id, key: record.fallback_key }, processedPath);

  upsertJsonl(processedPath, {
    id: record.id,
    fallback_key: record.fallback_key,
    title: record.raw.title,
    company: record.raw.company,
    score: record.eval.score,
    classification,
    reason: classification === 'irrelevant'
      ? (record.eval.rejection_reason ?? summarizeReason(record))
      : null,
    description_hash: record.description_hash,
    collected_at: record.collected_at,
    evaluated_at: record.eval.evaluated_at,
  });

  // Route to match files. On reclassification, remove from the file the job
  // no longer belongs to before inserting into the new one.
  if (classification !== 'good') removeFromJsonl(goodPath, key);
  if (classification !== 'mid') removeFromJsonl(midPath, key);
  if (classification === 'good') upsertJsonl(goodPath, record);
  if (classification === 'mid') upsertJsonl(midPath, record);

  // Hybrid write (spec decision): good matches also enter the existing
  // pipeline so `/career-ops pipeline` can run full A-G evaluation later.
  let pipelined = false;
  if (classification === 'good' && record.raw.job_url) {
    const { appendToPipeline, appendToScanHistory, loadSeenUrls } = await import('./scan.mjs');
    if (!loadSeenUrls().has(record.raw.job_url)) {
      const offer = {
        url: record.raw.job_url,
        company: record.raw.company ?? '?',
        title: record.raw.title ?? '',
        location: record.raw.location ?? '',
        source: 'linkedin',
        postedAt: parsePostedAt(record.raw.date_posted),
        description: record.raw.description ?? '',
      };
      appendToPipeline([offer]);
      appendToScanHistory([offer], new Date().toISOString().slice(0, 10));
      pipelined = true;
    }
  }

  return { classification, action: prev.found ? 'updated' : 'inserted', pipelined, id: record.id, key };
}

// ── Stats ───────────────────────────────────────────────────────────

export function computeStats(paths = {}) {
  const processed = readJsonl(paths.processed ?? PROCESSED_PATH);
  const counts = { processed: processed.length, good: 0, mid: 0, irrelevant: 0, errors: 0 };
  for (const r of processed) {
    if (r.classification === 'good') counts.good++;
    else if (r.classification === 'mid') counts.mid++;
    else if (r.classification === 'irrelevant') counts.irrelevant++;
    else counts.errors++;
  }
  return counts;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add saveJob routing with hybrid pipeline writes and stats"
```

---

### Task 7: CLI subcommands

**Files:**
- Modify: `linkedin-discover.mjs` (replace the Task 1 `main()` stub)
- Modify: `linkedin-discover.test.mjs`

**Interfaces:**
- Produces CLI: `config`, `check <jobId> [--key K] [--hash H]`, `save --json '{...}'`, `mark --json '{...}'`, `stats`, all JSON to stdout. Exit codes: 0 success, 1 runtime error, 2 usage. `--verbose` prints stack traces to stderr. Never prints full job descriptions.

- [ ] **Step 1: Add failing tests**

Add to the test file top: `import { execFileSync } from 'child_process';` and a helper + tests:

```js
// ── CLI ─────────────────────────────────────────────────────────────

const SCRIPT = pjoin(process.cwd(), 'linkedin-discover.mjs');

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf-8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

{
  const dir = mkdtempSync(pjoin(tmpdir(), 'li-cli-'));

  // config: defaults when portals.yml absent
  const conf = runCli(['config'], dir);
  assert(conf.code === 0, 'cli config: exit 0 without portals.yml');
  assert(JSON.parse(conf.stdout).location === 'United States', 'cli config: default location');

  // config: reads portals.yml linkedin block
  wf(pjoin(dir, 'portals.yml'), 'linkedin:\n  query: "staff engineer"\n  max_jobs: 10\n', 'utf-8');
  const conf2 = JSON.parse(runCli(['config'], dir).stdout);
  assert(conf2.query === 'staff engineer' && conf2.max_jobs === 10, 'cli config: yaml block merged');

  // save + check + stats round trip
  const job = JSON.stringify({
    raw: { title: 'Engineer', company: 'Acme', job_url: 'https://www.linkedin.com/jobs/view/4000000010/', description: 'jd' },
    eval: { score: 4.0, breakdown: {}, matching_reasons: [], missing_requirements: [], concerns: [] },
  });
  const saved = runCli(['save', '--json', job], dir);
  assert(saved.code === 0, 'cli save: exit 0');
  assert(JSON.parse(saved.stdout).classification === 'good', 'cli save: classification in output');
  assert(!saved.stdout.includes('"jd"'), 'cli save: output does not echo the description');

  const chk = runCli(['check', '4000000010'], dir);
  assert(chk.code === 0 && JSON.parse(chk.stdout).found === true, 'cli check: finds saved job');

  const st = runCli(['stats'], dir);
  assert(JSON.parse(st.stdout).good === 1, 'cli stats: counts saved job');

  // mark
  const mk = runCli(['mark', '--json', JSON.stringify({ raw: { title: 'Dead', company: 'Beta' }, status: 'closed', reason: 'expired' })], dir);
  assert(mk.code === 0, 'cli mark: exit 0');
  assert(JSON.parse(runCli(['stats'], dir).stdout).errors === 1, 'cli stats: marked job counted in errors');

  // error paths
  assert(runCli([], dir).code === 2, 'cli: no subcommand -> exit 2');
  assert(runCli(['bogus'], dir).code === 2, 'cli: unknown subcommand -> exit 2');
  assert(runCli(['save', '--json', '{not json'], dir).code === 1, 'cli save: bad JSON -> exit 1');
  assert(runCli(['save'], dir).code === 1, 'cli save: missing --json -> exit 1');

  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node linkedin-discover.test.mjs`
Expected: FAIL — `check`/`save`/`mark`/`stats` subcommands exit 2 (usage)

- [ ] **Step 3: Implement — replace the Task 1 `main()` and `usage()` with:**

```js
// ── CLI ─────────────────────────────────────────────────────────────

function usage() {
  console.error(`Usage:
  node linkedin-discover.mjs config
  node linkedin-discover.mjs check <jobId> [--key <fallbackKey>] [--hash <sha256>]
  node linkedin-discover.mjs save --json '<record JSON>'
  node linkedin-discover.mjs mark --json '<record JSON with status>'
  node linkedin-discover.mjs stats
Flags: --verbose (stack traces on error)`);
  process.exit(2);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const verbose = args.includes('--verbose');
  try {
    if (cmd === 'config') {
      const yamlObj = existsSync(PORTALS_PATH)
        ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))
        : {};
      console.log(JSON.stringify(resolveConfig(yamlObj), null, 2));
    } else if (cmd === 'check') {
      const id = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
      const key = argValue(args, '--key');
      const hash = argValue(args, '--hash');
      if (!id && !key) throw new Error('check: provide a job id or --key');
      const { found, changed, record } = checkJob({ id, key, hash });
      // Compact echo — never the full stored record (descriptions stay out of logs).
      console.log(JSON.stringify({
        found,
        changed,
        classification: record?.classification ?? null,
        score: record?.score ?? null,
      }));
    } else if (cmd === 'save' || cmd === 'mark') {
      const json = argValue(args, '--json');
      if (!json) throw new Error(`${cmd}: --json '<record>' is required`);
      let input;
      try { input = JSON.parse(json); }
      catch { throw new Error(`${cmd}: --json payload is not valid JSON`); }
      if (cmd === 'save') {
        const yamlObj = existsSync(PORTALS_PATH)
          ? yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))
          : {};
        const result = await saveJob(input, resolveConfig(yamlObj));
        console.log(JSON.stringify(result));
      } else {
        const entry = markJob(input);
        console.log(JSON.stringify({ marked: entry.classification, id: entry.id, key: entry.fallback_key }));
      }
    } else if (cmd === 'stats') {
      console.log(JSON.stringify(computeStats(), null, 2));
    } else {
      usage();
    }
  } catch (err) {
    console.error(`linkedin-discover: ${err.message}`);
    if (verbose) console.error(err.stack);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node linkedin-discover.test.mjs`
Expected: PASS, exit 0

- [ ] **Step 5: Commit**

```bash
git add linkedin-discover.mjs linkedin-discover.test.mjs
git commit -m "feat: add linkedin-discover CLI subcommands"
```

---

### Task 8: Registration (test-all, SYSTEM_PATHS, .gitignore, DATA_CONTRACT, portals example)

**Files:**
- Modify: `test-all.mjs` (~line 175, after `reply-matcher.test.mjs` entry)
- Modify: `update-system.mjs` (SYSTEM_PATHS array)
- Modify: `.gitignore`
- Modify: `DATA_CONTRACT.md` (user-layer table, near `data/scan-history.tsv` row; system-layer modes table)
- Modify: `templates/portals.example.yml` (append a commented optional block)

- [ ] **Step 1: Register the test suite in `test-all.mjs`**

After the line `{ name: 'reply-matcher.test.mjs', expectExit: 0 },` add:

```js
  { name: 'linkedin-discover.test.mjs', expectExit: 0 },
```

- [ ] **Step 2: Register system files in `update-system.mjs` SYSTEM_PATHS**

Next to the existing `'detect-reposts.mjs'` entry add `'linkedin-discover.mjs'`; next to `'detect-reposts.test.mjs'` add `'linkedin-discover.test.mjs'`; next to `'modes/pipeline.md'` add `'modes/linkedin.md'` (keep each list's local ordering style).

- [ ] **Step 3: Add `.gitignore` entry**

In the "Personal data (user fills these)" block, after `data/scan-runs.tsv` add:

```
data/linkedin/
```

- [ ] **Step 4: DATA_CONTRACT.md rows**

In the user-layer table (near the `data/scan-history.tsv` row) add:

```markdown
| `data/linkedin/*` | LinkedIn discovery results and resume state (`good_matches.jsonl`, `mid_matches.jsonl`, `processed_jobs.jsonl`) |
```

In the system-layer modes table (near `modes/pipeline.md`) add:

```markdown
| `modes/linkedin.md` | LinkedIn discovery mode instructions |
```

- [ ] **Step 5: Commented example block in `templates/portals.example.yml`**

Append after the last optional-filter block (before `# -- Title filter --`), matching the file's comment style:

```yaml
# -- LinkedIn discovery (optional) --
# Config for the agent-driven LinkedIn discovery mode (/career-ops linkedin).
# Requires the Playwright MCP server and a logged-in LinkedIn browser session.
# Discovery-only: the mode never applies, messages, or submits anything.
# Note: automated LinkedIn browsing violates LinkedIn ToS even when read-only;
# keep max_jobs conservative. See docs/linkedin-pipeline.md.
#
# linkedin:
#   enabled: true
#   query: "senior software engineer"   # required (here or in chat) — no default
#   location: "United States"           # default when absent
#   workplace_types: [remote]           # optional: remote | hybrid | onsite
#   seniority: []                       # optional LinkedIn seniority labels
#   date_posted: "past_week"            # optional: past_24h | past_week | past_month
#   max_jobs: 25                        # default 25
#   minimum_mid_score: 2.5              # 2.5 < score < 3.5 -> mid match
#   minimum_good_score: 3.5             # score >= 3.5 -> good match
```

- [ ] **Step 6: Verify**

Run: `node linkedin-discover.test.mjs && node validate-system-paths-coverage.mjs && node validate-portals.mjs --file templates/portals.example.yml`
Expected: all exit 0

- [ ] **Step 7: Commit**

```bash
git add test-all.mjs update-system.mjs .gitignore DATA_CONTRACT.md templates/portals.example.yml
git commit -m "chore: register linkedin discovery files in test suite, updater, and docs contracts"
```

---

### Task 9: Agent mode (`modes/linkedin.md`) + AGENTS.md wiring

**Files:**
- Create: `modes/linkedin.md`
- Modify: `AGENTS.md` (Skill Modes table + Main Files table)

- [ ] **Step 1: Create `modes/linkedin.md` with this exact content:**

````markdown
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
2. Dedup gate: `node linkedin-discover.mjs check <jobId> --hash <sha256-of-description>` — on the first pass before reading the description, call without `--hash`; if `found` and you have no reason to suspect change, count as duplicate-skipped and move on. If `found` + `changed: true` (hash differs), re-process.
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
````

- [ ] **Step 2: AGENTS.md — Skill Modes table row**

After the `scan` row add:

```markdown
| Wants to discover jobs on LinkedIn (authenticated session, discovery-only) | `linkedin` — Playwright MCP search + collect + compact scoring; good matches feed `data/pipeline.md`; never applies or messages |
```

- [ ] **Step 3: AGENTS.md — Main Files table rows**

After the `scan-ats-full.mjs` row add:

```markdown
| `linkedin-discover.mjs` | LinkedIn discovery helper — config/check/save/mark/stats for `modes/linkedin.md`; classifies scored jobs (good ≥ 3.5 / mid / irrelevant ≤ 2.5) into `data/linkedin/*.jsonl` and pipelines good matches (JSON output) |
| `data/linkedin/` | LinkedIn discovery outputs + resume state (user layer, gitignored) |
```

- [ ] **Step 4: Verify**

Run: `node test-all.mjs --only linkedin` (or `node linkedin-discover.test.mjs`) and `node doctor.mjs --json`
Expected: exit 0, doctor output unchanged

- [ ] **Step 5: Commit**

```bash
git add modes/linkedin.md AGENTS.md
git commit -m "feat: add linkedin discovery agent mode and register it in AGENTS.md"
```

---

### Task 10: User documentation

**Files:**
- Create: `docs/linkedin-pipeline.md`

- [ ] **Step 1: Write `docs/linkedin-pipeline.md`:**

````markdown
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
| Duplicate-looking rows in `pipeline.md` | Run `node reconcile-pipeline.mjs`; the helper dedups by URL before appending |
| Helper errors | Re-run the failing `node linkedin-discover.mjs ...` command with `--verbose` |
| Start over | Delete `data/linkedin/` (this loses resume state and results) |
````

- [ ] **Step 2: Cross-link from the mode**

No change needed — `templates/portals.example.yml` (Task 8) and `modes/linkedin.md` already reference `docs/linkedin-pipeline.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/linkedin-pipeline.md
git commit -m "docs: add linkedin discovery pipeline documentation"
```

---

### Task 11: Full verification

- [ ] **Step 1: Run the new suite**

Run: `node linkedin-discover.test.mjs`
Expected: all tests pass, exit 0

- [ ] **Step 2: Run the full repo suite**

Run: `node test-all.mjs`
Expected: exit 0 (includes the newly registered `linkedin-discover.test.mjs`, `validate-system-paths-coverage.mjs`, and `validate-portals.mjs --file templates/portals.example.yml`)

- [ ] **Step 3: Pipeline health check**

Run: `node verify-pipeline.mjs && node doctor.mjs --json`
Expected: exit 0, no new warnings

- [ ] **Step 4: Commit any fixes, then summarize**

Summarize for the user: files added/changed, how to run the mode, test results, and the standing limitations (ToS risk, layout fragility, no live-LinkedIn tests).
