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
