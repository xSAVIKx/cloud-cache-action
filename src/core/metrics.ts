/**
 * Structured per-step metrics. Every step emits one `cloud-cache-metrics <json>` debug line, and
 * appends the same JSON as one line to the `metrics-file` when one is configured. Writing that
 * file is best-effort by design: a machine-readable timing record must never fail a cache step.
 */

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
