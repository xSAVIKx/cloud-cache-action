import { getHost, type SummaryWriter } from '../ci/host';
import { log } from '../ci/log';
import { formatSize } from '../utils/inputUtils';
import { toError } from './outcomes';

export type CacheSource = 's3' | 'github' | 'none';

/** The value of the Result column of the restore table. */
export type RestoreSummaryResult =
  | 'exact hit'
  | 'partial hit (restore key)'
  | 'found (lookup only)'
  | 'miss'
  | 'error (no cache)'
  | 'skipped';

/** The value of the Result column of the save table. */
export type SaveSummaryResult =
  | 'saved'
  | 'already saved'
  | 'not necessary (exact hit)'
  | 'no files'
  | 'error (not saved)'
  | 'skipped';

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
  /** The lookup-only input. A matched key is then "found", not restored. */
  lookupOnly?: boolean;
  /** The step threw. The Result is then an error, and `errors` holds the message. */
  failed?: boolean;
  /** Tier errors that the step logged as warnings, and the error that the step threw. */
  errors?: readonly string[];
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
  /** How the save ended, as the metrics line reports it. */
  outcome?: 'saved' | 'exists' | 'skipped' | 'error';
  /** The restore had an exact hit, so an `exists` outcome means that no save was necessary. */
  exactHit?: boolean;
  /** Why a tier did not save, for a `skipped` outcome, for example `no paths matched`. */
  skipReason?: string;
  /** Tier errors that the step logged as warnings, and the error that the step threw. */
  errors?: readonly string[];
}

/** The restore Result. A tier error with no hit is an error, not a miss. */
export function restoreResult(data: RestoreSummaryData): RestoreSummaryResult {
  if (data.skipped !== undefined) {
    return 'skipped';
  }
  if (data.failed) {
    return 'error (no cache)';
  }
  if (data.matchedKey !== undefined) {
    if (data.lookupOnly) {
      return 'found (lookup only)';
    }
    return data.cacheHit ? 'exact hit' : 'partial hit (restore key)';
  }
  return (data.errors?.length ?? 0) > 0 ? 'error (no cache)' : 'miss';
}

/** The save Result. A tier error with no saved tier is an error. */
export function saveResult(data: SaveSummaryData): SaveSummaryResult {
  if (data.skipped !== undefined) {
    return 'skipped';
  }
  if (data.outcome === 'error' || (data.savedTo.length === 0 && (data.errors?.length ?? 0) > 0)) {
    return 'error (not saved)';
  }
  switch (data.outcome) {
    case 'saved':
      return 'saved';
    case 'exists':
      return data.exactHit ? 'not necessary (exact hit)' : 'already saved';
    case 'skipped':
      return data.skipReason === 'no paths matched' ? 'no files' : 'skipped';
    default:
      return data.savedTo.length > 0 ? 'saved' : 'skipped';
  }
}

/** One line that names the preset and the paths it resolved, under the table. */
function addPresetLine(preset: string | undefined, paths: readonly string[] | undefined): void {
  if (!preset) {
    return;
  }
  const list = (paths ?? []).map((p) => `<code>${escapeHtml(p)}</code>`).join(', ');
  writer().addRaw(`<p>Preset <code>${escapeHtml(preset)}</code>, path ${list}</p>`, true);
}

/** One line for each error, under the table. */
function addErrorLines(errors: readonly string[] | undefined): void {
  for (const error of errors ?? []) {
    writer().addRaw(`<p>Error: ${escapeHtml(error)}</p>`, true);
  }
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
        { data: 'Result', header: true },
        { data: 'Primary key', header: true },
        { data: 'Matched key', header: true },
        { data: 'Cache hit', header: true },
        { data: 'Source', header: true },
        { data: 'Size', header: true },
        { data: 'Duration', header: true },
      ],
      [
        restoreResult(data),
        escapeHtml(data.primaryKey),
        data.matchedKey === undefined ? '—' : escapeHtml(data.matchedKey),
        data.skipped === undefined ? String(data.cacheHit) : 'skipped',
        escapeHtml(data.source),
        formatOptionalSize(data.size),
        formatDuration(data.durationMs),
      ],
    ]);
  addErrorLines(data.errors);
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
        { data: 'Result', header: true },
        { data: 'Key', header: true },
        { data: 'Saved to', header: true },
        { data: 'Size', header: true },
        { data: 'Duration', header: true },
      ],
      [
        saveResult(data),
        escapeHtml(data.key),
        formatSavedTo(data),
        formatOptionalSize(data.size),
        formatDuration(data.durationMs),
      ],
    ]);
  addErrorLines(data.errors);
  addSkippedLine(
    data.skipped ?? (data.outcome === 'skipped' ? notNoFiles(data.skipReason) : undefined)
  );
  addPresetLine(data.preset, data.paths);
  await flush();
}

/** A tier skip reason for the Skipped line. "no files" is already the Result, so it gets no line. */
function notNoFiles(reason: string | undefined): string | undefined {
  return reason === 'no paths matched' ? undefined : reason;
}
