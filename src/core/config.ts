import { getHost } from '../ci/host';
import { log } from '../ci/log';
import { Defaults, Inputs, State } from '../constants';
import {
  parseMetadata,
  parseTags,
  MAX_TAGS_WITH_CHECKSUM,
  type ObjectTag,
} from './objectAttributes';
import type { IStateProvider } from '../state';
import type { PresetName } from './presets';
import {
  getInputAsArray,
  getInputAsBool,
  getInputAsEnum,
  getInputAsInt,
} from '../utils/inputUtils';

export const RESTORE_PRIORITIES = ['s3-first', 'github-first'] as const;
export const DUAL_CACHE_STRATEGIES = ['backfill', 'skip-on-hit'] as const;
export const TRANSFER_TUNINGS = ['fixed', 'auto'] as const;
export type RestorePriority = (typeof RESTORE_PRIORITIES)[number];
export type DualCacheStrategy = (typeof DUAL_CACHE_STRATEGIES)[number];
export type TransferTuning = (typeof TRANSFER_TUNINGS)[number];

/** Which transfer inputs the workflow set to a valid value. `auto` tuning leaves those alone. */
export interface ExplicitTransferInputs {
  uploadConcurrency: boolean;
  uploadChunkSize: boolean;
  downloadConcurrency: boolean;
  downloadChunkSize: boolean;
}

/** Every input the restore and save steps act on, parsed and defaulted once. */
export interface CacheConfig {
  primaryKey: string;
  paths: string[];
  /** The preset that gave the defaults, when the `preset` input is set (see presets.ts). */
  preset?: PresetName;
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
  /** `auto` selects the transfer settings per object, except the ones in `explicitTransfer`. */
  transferTuning: TransferTuning;
  explicitTransfer: ExplicitTransferInputs;
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
  if (getHost().input(Inputs.DualCacheStrategy).trim() === 'independent') {
    log.warning(
      'dual-cache-strategy "independent" was removed in v1.1; using "backfill", which now checks each tier before uploading.'
    );
    return 'backfill';
  }
  return getInputAsEnum(Inputs.DualCacheStrategy, DUAL_CACHE_STRATEGIES, 'backfill');
}

/**
 * Reads an integer input within [min, max]; anything else warns and uses the default. The
 * warning names `effective`, what the default stands for. `set` is true only for a valid value.
 */
function readBoundedInt<T extends number | undefined>(
  name: Inputs,
  defaultValue: T,
  min: number,
  max: number,
  effective: number | string = defaultValue as number
): { value: number | T; set: boolean } {
  const raw = getHost().input(name).trim();
  if (raw === '') {
    return { value: defaultValue, set: false };
  }
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isNaN(value) || value < min || value > max) {
    log.warning(
      `Input "${name}" must be an integer between ${min} and ${max}; got "${raw}". Using ${effective}.`
    );
    return { value: defaultValue, set: false };
  }
  return { value, set: true };
}

/** Reads `compression-level`; anything outside 1 to 19 warns and leaves the method's default. */
function readOptionalLevel(): number | undefined {
  const raw = getHost().input(Inputs.CompressionLevel).trim();
  if (raw === '') {
    return undefined;
  }
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isNaN(value) || value < 1 || value > Defaults.MaxCompressionLevel) {
    log.warning(
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
  const transferTuning = text(State.CacheTransferTuning, () =>
    getInputAsEnum(Inputs.TransferTuning, TRANSFER_TUNINGS, 'fixed')
  );
  // Under `auto`, an invalid transfer input leaves the field to the tuning, not to the default.
  const tuned = (effective: number): number | string =>
    transferTuning === 'auto' ? 'the transfer-tuning: auto value' : effective;
  const uploadChunkSize = readBoundedInt(
    Inputs.UploadChunkSize,
    undefined,
    Defaults.MinUploadChunkSize,
    Defaults.MaxUploadChunkSize,
    tuned(Defaults.DefaultUploadChunkSize)
  );
  const uploadConcurrency = readBoundedInt(
    Inputs.UploadConcurrency,
    Defaults.DefaultUploadConcurrency,
    1,
    Defaults.MaxUploadConcurrency,
    tuned(Defaults.DefaultUploadConcurrency)
  );
  const downloadConcurrency = readBoundedInt(
    Inputs.DownloadConcurrency,
    Defaults.DefaultDownloadConcurrency,
    1,
    Defaults.MaxDownloadConcurrency,
    tuned(Defaults.DefaultDownloadConcurrency)
  );
  const downloadChunkSize = readBoundedInt(
    Inputs.DownloadChunkSize,
    Defaults.DefaultDownloadChunkSize,
    Defaults.MinDownloadChunkSize,
    Defaults.MaxDownloadChunkSize,
    tuned(Defaults.DefaultDownloadChunkSize)
  );

  return {
    primaryKey: text(State.CachePrimaryKey, () => getHost().input(Inputs.Key).trim()),
    paths: json(State.CachePaths, () => getInputAsArray(Inputs.Path)),
    restoreKeys: getInputAsArray(Inputs.RestoreKeys),
    lookupOnly: getInputAsBool(Inputs.LookupOnly),
    failOnCacheMiss: getInputAsBool(Inputs.FailOnCacheMiss),
    readOnly: bool(State.CacheReadOnly, () => getInputAsBool(Inputs.ReadOnly)),
    enableCrossOsArchive: getInputAsBool(Inputs.EnableCrossOsArchive),
    uploadChunkSize: uploadChunkSize.value,
    uploadConcurrency: uploadConcurrency.value,
    compressionLevel: readOptionalLevel(),
    s3KeyPattern: text(
      State.CacheS3KeyPattern,
      () => getHost().input(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern
    ),
    prefix: text(State.CachePrefix, () => getHost().input(Inputs.Prefix)),
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
    downloadConcurrency: downloadConcurrency.value,
    downloadChunkSize: downloadChunkSize.value,
    transferTuning,
    explicitTransfer: {
      uploadConcurrency: uploadConcurrency.set,
      uploadChunkSize: uploadChunkSize.set,
      downloadConcurrency: downloadConcurrency.set,
      downloadChunkSize: downloadChunkSize.set,
    },
    jobSummary: bool(State.CacheJobSummary, () => getInputAsBool(Inputs.JobSummary, true)),
    metadata: json(State.CacheMetadata, () => parseMetadata(getHost().input(Inputs.Metadata))),
    tags: json(State.CacheTags, () =>
      parseTags(
        getHost().input(Inputs.Tags),
        'tags',
        streaming ? MAX_TAGS_WITH_CHECKSUM : undefined
      )
    ),
    explain: getInputAsBool(Inputs.Explain),
    metricsFile: text(State.CacheMetricsFile, () => getHost().input(Inputs.MetricsFile).trim()),
  };
}

/** Saves what the post step must agree on with the restore step. */
export function persistCacheConfig(state: IStateProvider, config: CacheConfig): void {
  state.setState(State.CachePrimaryKey, config.primaryKey);
  // A preset can give the paths, so the post step reads them from here, not from the input.
  state.setState(State.CachePaths, JSON.stringify(config.paths));
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
  state.setState(State.CacheTransferTuning, config.transferTuning);
}
