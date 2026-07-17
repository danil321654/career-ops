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

// ── Dedup keys ──────────────────────────────────────────────────────

// LinkedIn job URLs carry the numeric job id either in the path
// (/jobs/view/{id} or /jobs/view/{slug}-{id}) or as ?currentJobId={id}.
export function parseJobId(url) {
  if (typeof url !== 'string') return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
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

// ── JSONL store ─────────────────────────────────────────────────────
// Files are canonical (repo doctrine). Rewrites go through a temp file +
// atomic rename so an interrupted run never leaves a partial file.

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    try { out.push(JSON.parse(lines[i])); }
    catch { throw new Error(`${path}:${i + 1}: malformed JSONL line`); }
  }
  return out;
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
    const { seen: seenUrls } = loadSeenUrls();
    if (!seenUrls.has(record.raw.job_url)) {
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
