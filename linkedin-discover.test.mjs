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
  checkJob, markJob, saveJob, computeStats, GOOD_PATH, MID_PATH, PROCESSED_PATH,
} from './linkedin-discover.mjs';
import { mkdtempSync, rmSync, readFileSync as rf, writeFileSync as wf, existsSync as ex, readdirSync } from 'fs';
import { join as pjoin } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

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

// ── CLI ─────────────────────────────────────────────────────────────

const SCRIPT = pjoin(process.cwd(), 'linkedin-discover.mjs');

function runCli(args, cwd) {
  try {
    const env = { ...process.env };
    delete env.DOTENV_KEY;
    delete env.DOTENV_VAULT;
    delete env.DOTENV_PRIVATE_KEY_FALLBACK;
    const result = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Strip dotenvx logging output that may be mixed in
    const cleaned = result.split('\n').filter(line => !line.startsWith('◇')).join('\n');
    return { code: 0, stdout: cleaned };
  } catch (err) {
    let stdout = (err.stdout ?? '').split('\n').filter(line => !line.startsWith('◇')).join('\n');
    return { code: err.status, stdout, stderr: err.stderr ?? '' };
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

// ── summary ─────────────────────────────────────────────────────────

console.log(`\nlinkedin-discover tests: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed ? 1 : 0);
