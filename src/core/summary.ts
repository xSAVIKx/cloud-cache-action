import { getHost, type SummaryWriter } from '../ci/host';
import { log } from '../ci/log';
import { formatSize } from '../utils/inputUtils';
import { toError } from './outcomes';

export type CacheSource = 's3' | 'github' | 'none';

/** Data for the restore step's job summary table. `jobSummary` is the resolved job-summary input. */
export interface RestoreSummaryData {
  jobSummary: boolean;
  primaryKey: string;
  matchedKey?: string;
  cacheHit: boolean;
  source: CacheSource;
  size?: number;
  durationMs: number;
  metadata?: Record<string, string>;
  /** The preset that gave the defaults, if any; the summary then shows the resolved paths. */
  preset?: string;
  paths?: readonly string[];
  /** Why the step did not ask any tier, for example `ACTIONS_CACHE_MODE is none`. */
  skipped?: string;
}

/** Data for the save step's job summary table. `jobSummary` is the resolved job-summary input. */
export interface SaveSummaryData {
  jobSummary: boolean;
  key: string;
  savedTo: Array<'s3' | 'github'>;
  size?: number;
  durationMs: number;
  /** The preset that gave the defaults, if any; the summary then shows the resolved paths. */
  preset?: string;
  paths?: readonly string[];
  /** Why the step did not save to any tier, for example `ACTIONS_CACHE_MODE is read`. */
  skipped?: string;
}

/** One line that names the preset and the paths it resolved, under the table. */
function addPresetLine(preset: string | undefined, paths: readonly string[] | undefined): void {
  if (!preset) {
    return;
  }
  const list = (paths ?? []).map((p) => `<code>${escapeHtml(p)}</code>`).join(', ');
  writer().addRaw(`<p>Preset <code>${escapeHtml(preset)}</code>, path ${list}</p>`, true);
}

/** One line that tells why the step did not ask any tier, under the table. */
function addSkippedLine(reason: string | undefined): void {
  if (reason === undefined) {
    return;
  }
  writer().addRaw(`<p>Skipped: ${escapeHtml(reason)}</p>`, true);
}

function formatSavedTo(data: SaveSummaryData): string {
  if (data.savedTo.length > 0) {
    return escapeHtml(data.savedTo.join(', '));
  }
  return data.skipped === undefined ? 'none' : 'skipped';
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(2)} s`;
}

function formatOptionalSize(size?: number): string {
  return size === undefined ? '—' : formatSize(size);
}

/**
 * The job summary writes the text it is given into the HTML as is, so a key containing `<` or `&`
 * would break the markup. Every table cell and every `<pre>` line built from user data — here
 * and in the explain report's summary section — goes through this.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only write when the job-summary input is on and GitHub gave us a summary file to write to. */
export function canWrite(jobSummary: boolean): boolean {
  return jobSummary && getHost().summary !== undefined;
}

/** The host summary writer. Callers pass `canWrite` first, so it exists here. */
function writer(): SummaryWriter {
  const summary = getHost().summary;
  if (summary === undefined) {
    throw new Error('The CI host has no job summary writer.');
  }
  return summary;
}

/** A write failure (missing/unwritable summary file) is logged at debug level and never thrown. */
export async function flush(): Promise<void> {
  if (getHost().summary === undefined) {
    return;
  }
  try {
    await writer().write();
  } catch (err) {
    log.debug(`Failed to write the job summary: ${toError(err).message}`);
    writer().emptyBuffer();
  }
}

export async function writeRestoreSummary(data: RestoreSummaryData): Promise<void> {
  if (!canWrite(data.jobSummary)) {
    return;
  }
  writer()
    .addHeading('Cloud cache restore')
    .addTable([
      [
        { data: 'Primary key', header: true },
        { data: 'Matched key', header: true },
        { data: 'Cache hit', header: true },
        { data: 'Source', header: true },
        { data: 'Size', header: true },
        { data: 'Duration', header: true },
      ],
      [
        escapeHtml(data.primaryKey),
        data.matchedKey === undefined ? '—' : escapeHtml(data.matchedKey),
        data.skipped === undefined ? String(data.cacheHit) : 'skipped',
        escapeHtml(data.source),
        formatOptionalSize(data.size),
        formatDuration(data.durationMs),
      ],
    ]);
  addSkippedLine(data.skipped);
  addPresetLine(data.preset, data.paths);
  if (data.metadata && Object.keys(data.metadata).length > 0) {
    writer().addDetails(
      'Object metadata',
      `<ul>${Object.entries(data.metadata)
        .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${escapeHtml(v)}</li>`)
        .join('')}</ul>`
    );
  }
  await flush();
}

export async function writeSaveSummary(data: SaveSummaryData): Promise<void> {
  if (!canWrite(data.jobSummary)) {
    return;
  }
  writer()
    .addHeading('Cloud cache save')
    .addTable([
      [
        { data: 'Key', header: true },
        { data: 'Saved to', header: true },
        { data: 'Size', header: true },
        { data: 'Duration', header: true },
      ],
      [
        escapeHtml(data.key),
        formatSavedTo(data),
        formatOptionalSize(data.size),
        formatDuration(data.durationMs),
      ],
    ]);
  addSkippedLine(data.skipped);
  addPresetLine(data.preset, data.paths);
  await flush();
}
