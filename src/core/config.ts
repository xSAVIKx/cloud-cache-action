import * as core from '@actions/core';
import { Defaults, Inputs, State } from '../constants';
import {
  parseMetadata,
  parseTags,
  MAX_TAGS_WITH_CHECKSUM,
  type ObjectTag,
} from './objectAttributes';
import type { IStateProvider } from '../state';
import {
  getInputAsArray,
  getInputAsBool,
  getInputAsEnum,
  getInputAsInt,
} from '../utils/inputUtils';

export const RESTORE_PRIORITIES = ['s3-first', 'github-first'] as const;
export const DUAL_CACHE_STRATEGIES = ['backfill', 'skip-on-hit'] as const;
export type RestorePriority = (typeof RESTORE_PRIORITIES)[number];
export type DualCacheStrategy = (typeof DUAL_CACHE_STRATEGIES)[number];

/** Every input the restore and save steps act on, parsed and defaulted once. */
export interface CacheConfig {
  primaryKey: string;
  paths: string[];
  restoreKeys: string[];
  lookupOnly: boolean;
  failOnCacheMiss: boolean;
  readOnly: boolean;
  enableCrossOsArchive: boolean;
  /**
   * Bytes per multipart upload part, when set; undefined leaves each tier to its own default
   * (64 MiB on S3, the toolkit's on the GitHub tier). An out-of-range value warns and is unset.
   */
  uploadChunkSize?: number;
  /** Multipart upload parts in flight at once on the S3 tier. */
  uploadConcurrency: number;
  /** zstd or gzip level for saving; undefined keeps each method's own default. */
  compressionLevel?: number;
  s3KeyPattern: string;
  prefix: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  retryEnabled: boolean;
  retryCount: number;
  useFallback: boolean;
  dualCache: boolean;
  restorePriority: RestorePriority;
  dualCacheStrategy: DualCacheStrategy;
  dualCacheStrict: boolean;
  streaming: boolean;
  /** Ranged GET requests a restore runs at once; 1 downloads the object in one request. */
  downloadConcurrency: number;
  /** Bytes per ranged GET request; objects no larger than this use one request. */
  downloadChunkSize: number;
  jobSummary: boolean;
  /** User metadata written on every object this step saves (Task 1 parsing rules). */
  metadata: Record<string, string>;
  /** Object tags written on every object this step saves. */
  tags: ObjectTag[];
  /** Logs the cache lookup report before restoring; never persisted, so the post step never explains. */
  explain: boolean;
  /** Workspace-relative file that gets one JSON line of metrics per step; '' disables it. */
  metricsFile: string;
}

function readDualCacheStrategy(): DualCacheStrategy {
  if (core.getInput(Inputs.DualCacheStrategy).trim() === 'independent') {
    core.warning(
      'dual-cache-strategy "independent" was removed in v1.1; using "backfill", which now checks each tier before uploading.'
    );
    return 'backfill';
  }
  return getInputAsEnum(Inputs.DualCacheStrategy, DUAL_CACHE_STRATEGIES, 'backfill');
}

/**
 * Reads an integer input within [min, max]; anything else warns and uses the default. The
 * warning names `effective`, the value the default stands for, when the default is undefined.
 */
function readBoundedInt<T extends number | undefined>(
  name: Inputs,
  defaultValue: T,
  min: number,
  max: number,
  effective: number = defaultValue as number
): number | T {
  const raw = core.getInput(name).trim();
  if (raw === '') {
    return defaultValue;
  }
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isNaN(value) || value < min || value > max) {
    core.warning(
      `Input "${name}" must be an integer between ${min} and ${max}; got "${raw}". Using ${effective}.`
    );
    return defaultValue;
  }
  return value;
}

/** Reads `compression-level`; anything outside 1 to 19 warns and leaves the method's default. */
function readOptionalLevel(): number | undefined {
  const raw = core.getInput(Inputs.CompressionLevel).trim();
  if (raw === '') {
    return undefined;
  }
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isNaN(value) || value < 1 || value > Defaults.MaxCompressionLevel) {
    core.warning(
      `Input "${Inputs.CompressionLevel}" must be an integer between 1 and ${Defaults.MaxCompressionLevel}; got "${raw}". Using the default for the compression method.`
    );
    return undefined;
  }
  return value;
}

/**
 * Reads the action inputs. When `state` is given (the post step), values the restore step
 * persisted win, so both steps compute the same object keys and warnings are not repeated.
 */
export function readCacheConfig(state?: IStateProvider): CacheConfig {
  const persisted = (key: State): string => state?.getState(key) ?? '';
  const bool = (key: State, read: () => boolean): boolean => {
    const value = persisted(key);
    return value === '' ? read() : value === 'true';
  };
  const text = <T extends string>(key: State, read: () => T): T => (persisted(key) as T) || read();
  const json = <T>(key: State, read: () => T): T => {
    const value = persisted(key);
    return value === '' ? read() : (JSON.parse(value) as T);
  };
  const retryCountState = persisted(State.CacheRetryCount);
  const streaming = bool(State.CacheStreaming, () => getInputAsBool(Inputs.Streaming));

  return {
    primaryKey: text(State.CachePrimaryKey, () => core.getInput(Inputs.Key).trim()),
    paths: getInputAsArray(Inputs.Path),
    restoreKeys: getInputAsArray(Inputs.RestoreKeys),
    lookupOnly: getInputAsBool(Inputs.LookupOnly),
    failOnCacheMiss: getInputAsBool(Inputs.FailOnCacheMiss),
    readOnly: bool(State.CacheReadOnly, () => getInputAsBool(Inputs.ReadOnly)),
    enableCrossOsArchive: getInputAsBool(Inputs.EnableCrossOsArchive),
    uploadChunkSize: readBoundedInt(
      Inputs.UploadChunkSize,
      undefined,
      Defaults.MinUploadChunkSize,
      Defaults.MaxUploadChunkSize,
      Defaults.DefaultUploadChunkSize
    ),
    uploadConcurrency: readBoundedInt(
      Inputs.UploadConcurrency,
      Defaults.DefaultUploadConcurrency,
      1,
      Defaults.MaxUploadConcurrency
    ),
    compressionLevel: readOptionalLevel(),
    s3KeyPattern: text(
      State.CacheS3KeyPattern,
      () => core.getInput(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern
    ),
    prefix: text(State.CachePrefix, () => core.getInput(Inputs.Prefix)),
    scopedToRepository: bool(State.CacheScopedToRepository, () =>
      getInputAsBool(Inputs.ScopedToRepository, true)
    ),
    scopedToRef: bool(State.CacheScopedToRef, () => getInputAsBool(Inputs.ScopedToRef, true)),
    retryEnabled: bool(State.CacheRetry, () => getInputAsBool(Inputs.Retry, true)),
    retryCount:
      retryCountState !== ''
        ? Number(retryCountState)
        : (getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount),
    useFallback: getInputAsBool(Inputs.UseFallback),
    dualCache: bool(State.CacheDualCache, () => getInputAsBool(Inputs.DualCache)),
    restorePriority: text(State.CacheRestorePriority, () =>
      getInputAsEnum(Inputs.RestorePriority, RESTORE_PRIORITIES, 's3-first')
    ),
    dualCacheStrategy: text(State.CacheDualCacheStrategy, readDualCacheStrategy),
    dualCacheStrict: bool(State.CacheDualCacheStrict, () => getInputAsBool(Inputs.DualCacheStrict)),
    streaming,
    downloadConcurrency: readBoundedInt(
      Inputs.DownloadConcurrency,
      Defaults.DefaultDownloadConcurrency,
      1,
      Defaults.MaxDownloadConcurrency
    ),
    downloadChunkSize: readBoundedInt(
      Inputs.DownloadChunkSize,
      Defaults.DefaultDownloadChunkSize,
      Defaults.MinDownloadChunkSize,
      Defaults.MaxDownloadChunkSize
    ),
    jobSummary: bool(State.CacheJobSummary, () => getInputAsBool(Inputs.JobSummary, true)),
    metadata: json(State.CacheMetadata, () => parseMetadata(core.getInput(Inputs.Metadata))),
    tags: json(State.CacheTags, () =>
      parseTags(core.getInput(Inputs.Tags), 'tags', streaming ? MAX_TAGS_WITH_CHECKSUM : undefined)
    ),
    explain: getInputAsBool(Inputs.Explain),
    metricsFile: text(State.CacheMetricsFile, () => core.getInput(Inputs.MetricsFile).trim()),
  };
}

/** Saves what the post step must agree on with the restore step. */
export function persistCacheConfig(state: IStateProvider, config: CacheConfig): void {
  state.setState(State.CachePrimaryKey, config.primaryKey);
  state.setState(State.CacheReadOnly, String(config.readOnly));
  state.setState(State.CacheS3KeyPattern, config.s3KeyPattern);
  state.setState(State.CachePrefix, config.prefix);
  state.setState(State.CacheScopedToRepository, String(config.scopedToRepository));
  state.setState(State.CacheScopedToRef, String(config.scopedToRef));
  state.setState(State.CacheRetry, String(config.retryEnabled));
  state.setState(State.CacheRetryCount, String(config.retryCount));
  state.setState(State.CacheDualCache, String(config.dualCache));
  state.setState(State.CacheRestorePriority, config.restorePriority);
  state.setState(State.CacheDualCacheStrategy, config.dualCacheStrategy);
  state.setState(State.CacheDualCacheStrict, String(config.dualCacheStrict));
  state.setState(State.CacheStreaming, String(config.streaming));
  state.setState(State.CacheJobSummary, String(config.jobSummary));
  state.setState(State.CacheMetadata, JSON.stringify(config.metadata));
  state.setState(State.CacheTags, JSON.stringify(config.tags));
  state.setState(State.CacheMetricsFile, config.metricsFile);
}
