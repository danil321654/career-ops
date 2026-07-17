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

// ── summary ─────────────────────────────────────────────────────────

console.log(`\nlinkedin-discover tests: ${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed ? 1 : 0);
