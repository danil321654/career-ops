/**
 * linkedin-discover.mjs — LinkedIn board wrapper over discover-core.mjs.
 * The agent mode (modes/linkedin.md) does all Playwright MCP browsing and
 * scoring; this script supplies the LinkedIn-specific pieces (data paths,
 * config block, URL→id parser, raw-field list, pipeline source tag) and
 * delegates everything else — classification, dedup, JSONL storage, resume
 * state, hybrid pipeline writes, CLI — to discover-core.mjs.
 *
 * Subcommands: config | check | save | mark | stats (see discover-core runCli).
 * Design spec: docs/superpowers/specs/2026-07-17-linkedin-discovery-design.md
 */

import { join } from 'path';
import { pathToFileURL } from 'url';
import {
  classify, normalizeField, fallbackKey, descriptionHash, parsePostedAt,
  NORMALIZED_FIELDS, readJsonl, writeJsonlAtomic, recordKey, upsertJsonl,
  removeFromJsonl, MARK_STATUSES,
  resolveConfigCore, normalizeJobCore, markJobCore, saveJobCore,
  computeStatsCore, checkJob as checkJobCore, runCli,
} from './discover-core.mjs';

export {
  classify, normalizeField, fallbackKey, descriptionHash, parsePostedAt,
  NORMALIZED_FIELDS, readJsonl, writeJsonlAtomic, recordKey, upsertJsonl,
  removeFromJsonl, MARK_STATUSES,
};

export const DATA_DIR = 'data/linkedin';
export const GOOD_PATH = join(DATA_DIR, 'good_matches.jsonl');
export const MID_PATH = join(DATA_DIR, 'mid_matches.jsonl');
export const PROCESSED_PATH = join(DATA_DIR, 'processed_jobs.jsonl');

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
  return resolveConfigCore(yamlObj, 'linkedin', DEFAULTS);
}

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

export const RAW_FIELDS = Object.freeze([
  'title', 'company', 'company_linkedin_url', 'job_url', 'location',
  'workplace_type', 'employment_type', 'seniority', 'salary_range',
  'date_posted', 'applicants', 'description', 'company_info',
]);

export function normalizeJob(input) {
  return normalizeJobCore(input, { rawFields: RAW_FIELDS, parseId: parseJobId });
}

export function checkJob(query = {}, processedPath = PROCESSED_PATH) {
  return checkJobCore(query, processedPath);
}

export function markJob(input, processedPath = PROCESSED_PATH) {
  return markJobCore(input, processedPath, normalizeJob);
}

export async function saveJob(input, cfg = DEFAULTS, paths = {}) {
  return saveJobCore(input, cfg, {
    good: paths.good ?? GOOD_PATH,
    mid: paths.mid ?? MID_PATH,
    processed: paths.processed ?? PROCESSED_PATH,
    source: 'linkedin',
    normalizeFn: normalizeJob,
  });
}

export function computeStats(paths = {}) {
  return computeStatsCore(paths.processed ?? PROCESSED_PATH);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli({
    scriptName: 'linkedin-discover.mjs',
    resolveConfig, checkJob, saveJob, markJob, computeStats,
  });
}
