/**
 * linkedin-discover.test.mjs — Test suite for linkedin-discover.mjs
 *
 * Run: node linkedin-discover.test.mjs
 * Convention: self-runner with pass/fail counters (see detect-reposts.test.mjs).
 * Never touches live LinkedIn or the network.
 */

import {
  DEFAULTS, resolveConfig, classify,
  parseJobId, normalizeField, fallbackKey,
  normalizeJob, descriptionHash, parsePostedAt, RAW_FIELDS, NORMALIZED_FIELDS,
  readJsonl, writeJsonlAtomic, upsertJsonl, removeFromJsonl, recordKey,
  checkJob, markJob,
} from './linkedin-discover.mjs';
import { mkdtempSync, rmSync, readFileSync as rf, writeFileSync as wf, existsSync as ex, readdirSync } from 'fs';
import { join as pjoin } from 'path';
import { tmpdir } from 'os';

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
assert(parseJobId('https://example.com/jobs/view/4012345678/') === null,
  'parseJobId: non-linkedin host with linkedin-shaped path -> null');
assert(parseJobId('https://evil.example.com/apply?currentJobId=4098765432') === null,
  'parseJobId: non-linkedin host with currentJobId param -> null');
assert(parseJobId('not a url /jobs/view/4012345678') === null,
  'parseJobId: unparseable URL -> null');

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

  // atomicity: a failing write must leave the existing file untouched
  const before = rf(file, 'utf-8');
  const circular = { id: 'c1', fallback_key: 'c|c|c' };
  circular.self = circular;
  assertThrows(() => upsertJsonl(file, circular), 'jsonl: unserializable record throws');
  assert(rf(file, 'utf-8') === before, 'jsonl: failed write leaves file byte-identical');

  // malformed-line error carries the PHYSICAL line number (blank lines counted)
  wf(pjoin(dir, 'blank.jsonl'), '{"ok":1}\n\nnot json\n', 'utf-8');
  let lineErr = null;
  try { readJsonl(pjoin(dir, 'blank.jsonl')); } catch (e) { lineErr = e.message; }
  assert(lineErr !== null && lineErr.includes('blank.jsonl:3'),
    `jsonl: malformed-line error names physical line 3 (got: ${lineErr})`);

  // malformed line -> loud error with path and line number
  wf(file, '{"ok":1}\nnot json\n', 'utf-8');
  assertThrows(() => readJsonl(file), 'jsonl: malformed line throws');

  rmSync(dir, { recursive: true, force: true });
}

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

// ── summary ─────────────────────────────────────────────────────────

console.log(`\nlinkedin-discover tests: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed ? 1 : 0);
