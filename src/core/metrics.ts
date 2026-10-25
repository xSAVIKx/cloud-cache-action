/**
 * Structured per-step metrics. Every step emits one `cloud-cache-metrics <json>` debug line, and
 * appends the same JSON as one line to the `metrics-file` when one is configured. Writing that
 * file is best-effort by design: a machine-readable timing record must never fail a cache step.
 */

import { getHost } from '../ci/host';
import { log } from '../ci/log';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toError } from './outcomes';

export interface StepMetrics {
  step: 'restore' | 'save' | 'prune' | 'inspect';
  /** ISO 8601, taken when the step finished. */
  timestamp: string;
  provider?: string;
  key?: string;
  matchedKey?: string;
  objectKey?: string;
  source?: 's3' | 'github' | 'none';
  savedTo?: Array<'s3' | 'github'>;
  bytes: number;
  /** Wall-clock time of the whole step. */
  durationMs: number;
  /** Time spent on the S3 download or upload alone, when one happened. */
  transferDurationMs?: number;
  /** Restore: time to find the matching S3 object. */
  lookupDurationMs?: number;
  /** File-mode save: time to write and hash the archive. */
  archiveDurationMs?: number;
  /** File-mode restore: time to unpack the archive. */
  extractDurationMs?: number;
  streaming?: boolean;
  /** Ranged requests the restore download used; 1 for a single GetObject, 0 with no download. */
  downloadParts?: number;
  outcome:
    | 'hit'
    | 'miss'
    | 'saved'
    | 'exists'
    | 'skipped'
    | 'error'
    | 'pruned'
    | 'would-hit'
    | 'would-miss';
  /** Set only off GitHub: the CI platform. */
  platform?: string;
  /** Set only off GitHub: the archive compression of the S3 tier. */
  compression?: 'zstd' | 'gzip';
  /** Set only off GitHub: the resolved region of the S3 client. */
  region?: string;
  /** Set only off GitHub: the time the step script spent on setup, from CLOUD_CACHE_SETUP_MS. */
  setupMs?: number;
  /** Set only off GitHub: labels of the runner. */
  runner?: Record<string, string | number>;
  /** Step-specific counters, such as the prune tallies or the inspect candidate count. */
  extra?: Record<string, number | string | boolean>;
}

/** Debug-logs the metrics and, when `metricsFile` is set, appends them as one JSON line. */
export function emitMetrics(metrics: StepMetrics, metricsFile: string, workspace: string): void {
  const line = JSON.stringify(metrics);
  log.debug(`cloud-cache-metrics ${line}`);
  if (metricsFile === '') {
    return;
  }
  const resolved = path.resolve(workspace, metricsFile);
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, `${line}\n`);
  } catch (err) {
    log.warning(`Could not write metrics to ${resolved}: ${toError(err).message}`);
  }
}

/**
 * The platform fields for a restore or save record. On GitHub it returns no key, so the GitHub
 * metrics line does not change. A value that is not known is left out.
 */
export function hostMetricsFields(
  compression: 'zstd' | 'gzip' | undefined,
  region: string | undefined
): Partial<StepMetrics> {
  const context = getHost().context();
  if (context.platform === 'github') {
    return {};
  }
  const fields: Partial<StepMetrics> = { platform: context.platform };
  if (compression) {
    fields.compression = compression;
  }
  if (region) {
    fields.region = region;
  }
  const setup = context.env.CLOUD_CACHE_SETUP_MS;
  if (setup !== undefined && setup !== '') {
    if (/^\d+$/.test(setup.trim())) {
      fields.setupMs = Number(setup.trim());
    } else {
      log.warning(`CLOUD_CACHE_SETUP_MS is not a whole number (${setup}), so it is ignored.`);
    }
  }
  if (context.labels) {
    fields.runner = context.labels;
  }
  return fields;
}
