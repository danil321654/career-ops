/**
 * indeed-discover.test.mjs — Test suite for indeed-discover.mjs
 *
 * Run: node indeed-discover.test.mjs
 * Board-agnostic logic (classify, JSONL store, check/mark routing) is covered
 * by linkedin-discover.test.mjs against the shared discover-core; this suite
 * covers the Indeed-specific surface: job-key parsing, config block, path
 * separation, and the source=indeed hybrid write.
 * Never touches live Indeed or the network.
 */

import {
  DEFAULTS, resolveConfig, parseIndeedJobKey, normalizeJob,
  saveJob, checkJob, computeStats, readJsonl,
  DATA_DIR, GOOD_PATH, MID_PATH, PROCESSED_PATH, RAW_FIELDS,
} from './indeed-discover.mjs';
import { readFileSync as rf, writeFileSync as wf, mkdtempSync, rmSync } from 'fs';
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

// ── config: indeed block, same defaults as linkedin ─────────────────

{
  const cfg = resolveConfig({});
  assert(cfg.location === 'United States', 'config: default location is United States');
  assert(cfg.minimum_good_score === 3.5 && cfg.minimum_mid_score === 2.5, 'config: default thresholds 3.5/2.5');
  assert(cfg.max_jobs === 25, 'config: default max_jobs 25');
  assert(cfg.query === null, 'config: no default query');
}

{
  const cfg = resolveConfig({
    indeed: { query: 'data engineer', max_jobs: 40 },
    linkedin: { query: 'SHOULD NOT LEAK', max_jobs: 99 },
  });
  assert(cfg.query === 'data engineer' && cfg.max_jobs === 40, 'config: reads the indeed block');
  assert(cfg.query !== 'SHOULD NOT LEAK', 'config: linkedin block does not leak into indeed config');
}

assertThrows(() => resolveConfig({ indeed: { minimum_mid_score: 4, minimum_good_score: 3 } }),
  'config: mid >= good throws');

// ── paths: separated from linkedin ──────────────────────────────────

assert(DATA_DIR === 'data/indeed', 'paths: DATA_DIR is data/indeed');
assert(GOOD_PATH === pjoin('data/indeed', 'good_matches.jsonl'), 'paths: good file under data/indeed');
assert(!PROCESSED_PATH.includes('linkedin'), 'paths: processed file not under data/linkedin');
assert(RAW_FIELDS.includes('company_url') && !RAW_FIELDS.includes('company_linkedin_url'),
  'raw fields: indeed uses company_url');

// ── parseIndeedJobKey ───────────────────────────────────────────────

assert(parseIndeedJobKey('https://www.indeed.com/viewjob?jk=abc123def4567890') === 'abc123def4567890',
  'jobKey: viewjob jk param');
assert(parseIndeedJobKey('https://www.indeed.com/rc/clk?jk=abc123def4567890&from=serp') === 'abc123def4567890',
  'jobKey: rc/clk redirect URL');
assert(parseIndeedJobKey('https://www.indeed.com/jobs?q=engineer&l=US&vjk=00fedcba98765432') === '00fedcba98765432',
  'jobKey: serp vjk param');
assert(parseIndeedJobKey('https://pl.indeed.com/viewjob?jk=abc123def4567890') === 'abc123def4567890',
  'jobKey: country subdomain accepted');
assert(parseIndeedJobKey('https://evil.example.com/viewjob?jk=abc123def4567890') === null,
  'jobKey: non-indeed host -> null');
assert(parseIndeedJobKey('https://indeed.com.evil.com/viewjob?jk=abc123def4567890') === null,
  'jobKey: suffix-spoofed host -> null');
assert(parseIndeedJobKey('https://www.indeed.com/jobs?q=engineer') === null,
  'jobKey: no key param -> null');
assert(parseIndeedJobKey('not a url') === null, 'jobKey: unparseable -> null');
assert(parseIndeedJobKey(null) === null, 'jobKey: null -> null');
assert(parseIndeedJobKey('https://www.indeed.com/viewjob?jk=SHOUTING') === null,
  'jobKey: non-hex jk -> null');

// ── normalizeJob: indeed id derivation ──────────────────────────────

{
  const rec = normalizeJob({ raw: {
    title: 'Data Engineer', company: 'Acme Corp',
    job_url: 'https://www.indeed.com/viewjob?jk=abc123def4567890',
    location: 'Remote in United States',
  } });
  assert(rec.id === 'abc123def4567890', 'normalizeJob: id from indeed jk');
  assert(rec.raw.company_url === null, 'normalizeJob: missing company_url -> null');
  assert(rec.fallback_key === 'acme corp|data engineer|remote in united states',
    'normalizeJob: fallback key computed');
}

assertThrows(() => normalizeJob({ raw: { applicants: '5' } }),
  'normalizeJob: malformed page throws');

// ── saveJob: routing + source=indeed hybrid write + separation ──────

{
  const dir = mkdtempSync(pjoin(tmpdir(), 'indeed-save-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const cfg = { minimum_mid_score: 2.5, minimum_good_score: 3.5 };
    const mkJob = (jk, score, over = {}) => ({
      raw: {
        title: over.title ?? 'Data Engineer',
        company: over.company ?? 'Acme Corp',
        job_url: `https://www.indeed.com/viewjob?jk=${jk}`,
        location: 'United States',
        date_posted: '2026-07-15',
        description: over.description ?? `JD body for ${jk}`,
      },
      eval: {
        score,
        breakdown: { cv_match: score, north_star: score, comp: score, culture: score, red_flags: 'none' },
        matching_reasons: [], missing_requirements: [], concerns: [],
      },
    });

    const g = await saveJob(mkJob('aaaa111122223333', 4.2), cfg);
    assert(g.classification === 'good' && g.pipelined === true, 'save: good match pipelined');
    assert(readJsonl(GOOD_PATH).length === 1, 'save: good match in data/indeed/good_matches.jsonl');
    assert(!rf('data/pipeline.md', 'utf-8').includes('linkedin')
      && rf('data/scan-history.tsv', 'utf-8').includes('indeed'),
      'save: scan-history row carries portal=indeed');

    const m = await saveJob(mkJob('bbbb111122223333', 3.0), cfg);
    assert(m.classification === 'mid' && m.pipelined === false, 'save: mid not pipelined');
    assert(readJsonl(MID_PATH).length === 1, 'save: mid match in data/indeed/mid_matches.jsonl');

    const i = await saveJob(mkJob('cccc111122223333', 2.0), cfg);
    assert(i.classification === 'irrelevant', 'save: 2.0 irrelevant');
    assert(readJsonl(PROCESSED_PATH).length === 3, 'save: all three in processed');

    // resume + dedup by job key
    assert(checkJob({ id: 'aaaa111122223333' }).found === true, 'check: saved job found by jk');
    assert(checkJob({ id: 'ffff000000000000' }).found === false, 'check: unseen jk not found');

    // no linkedin files created
    assert(readJsonl(pjoin('data/linkedin', 'good_matches.jsonl')).length === 0,
      'separation: nothing written under data/linkedin');

    const s = computeStats();
    assert(s.processed === 3 && s.good === 1 && s.mid === 1 && s.irrelevant === 1,
      `stats: counts correct (got ${JSON.stringify(s)})`);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── CLI smoke: config + unknown command exit codes ──────────────────

{
  const SCRIPT = pjoin(process.cwd(), 'indeed-discover.mjs');
  const dir = mkdtempSync(pjoin(tmpdir(), 'indeed-cli-'));
  function runCli(args, cwd) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf-8' });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }
  const conf = runCli(['config'], dir);
  assert(conf.code === 0 && JSON.parse(conf.stdout).location === 'United States',
    'cli config: defaults without portals.yml');
  wf(pjoin(dir, 'portals.yml'), 'indeed:\n  query: "ml engineer"\n', 'utf-8');
  assert(JSON.parse(runCli(['config'], dir).stdout).query === 'ml engineer',
    'cli config: reads indeed yaml block');
  assert(runCli([], dir).code === 2, 'cli: no subcommand -> exit 2');
  assert(runCli(['save'], dir).code === 1, 'cli save: missing --json -> exit 1');
  rmSync(dir, { recursive: true, force: true });
}

// ── summary ─────────────────────────────────────────────────────────

console.log(`\nindeed-discover tests: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed ? 1 : 0);
