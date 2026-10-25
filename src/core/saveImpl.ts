import { getHost } from '../ci/host';
import { log } from '../ci/log';
import { Outputs, State } from '../constants';
import { NullStateProvider, type IStateProvider } from '../state';
import { isWriteAccessDeniedError } from '../storage/errors';
import { isValidEvent } from '../utils/inputUtils';
import { getCacheMode, isCacheWritable } from './cacheMode';
import { readCacheConfig, type CacheConfig } from './config';
import { emitMetrics, hostMetricsFields, type StepMetrics } from './metrics';
import { formatTimings } from './timings';
import { toError, type S3ObjectInfo } from './outcomes';
import { applyPreset, readPreset } from './presets';
import { buildS3Tier, saveToS3, type S3Tier } from './s3Tier';
import { writeSaveSummary } from './summary';

/** What got saved where, so the caller can build the job summary and its own return value. */
interface SaveResult {
  size?: number;
  sources: Array<'s3' | 'github'>;
  /** The S3 object this step wrote or found, for the metrics line. */
  objectKey?: string;
  /** The S3 upload alone, when one happened. */
  transferMs?: number;
  /** The archive write and hash of a file-mode S3 save. */
  archiveMs?: number;
  /** How the step ended, as the metrics line reports it. */
  outcome: Extract<StepMetrics['outcome'], 'saved' | 'exists' | 'skipped' | 'error'>;
  /** A tier error that was warned away rather than thrown, when nothing was saved. */
  error?: string;
}

const ACCESS_DENIED_HINT =
  'The credentials may not be allowed to write to the bucket. Set read-only: true to skip the save.';

/**
 * The S3 save error message, with a hint about read-only when S3 denied a write call. A 403 on a
 * read call, such as the HeadObject existence check, gets no hint: it means wrong credentials or
 * a policy without s3:ListBucket, and read-only would only hide that.
 */
function s3SaveError(error: Error): Error {
  if (!isWriteAccessDeniedError(error)) {
    return error;
  }
  const message = error.message.replace(/\.$/, '');
  return new Error(`${message}. ${ACCESS_DENIED_HINT}`, { cause: error });
}

function reportS3(info: S3ObjectInfo | undefined): void {
  if (!info) {
    return;
  }
  getHost().setOutput(Outputs.CacheS3Key, info.objectKey);
  getHost().setOutput(Outputs.CacheSize, String(info.size));
  if (info.etag) {
    getHost().setOutput(Outputs.CacheETag, info.etag);
  }
}

async function setUpS3(
  config: CacheConfig,
  stateProvider: IStateProvider
): Promise<S3Tier | undefined> {
  try {
    const tier = await buildS3Tier(config, process.env, {
      compression: stateProvider.getState(State.CacheCompression),
    });
    getHost().setOutput(Outputs.CacheStorageProvider, tier.storage.providerConfig.provider);
    return tier;
  } catch (err) {
    const otherTierMayServe = config.dualCache ? !config.dualCacheStrict : config.useFallback;
    if (!otherTierMayServe) {
      throw err;
    }
    log.warning(`S3 client initialization failed during save: ${toError(err).message}`);
    return undefined;
  }
}

async function saveSingleTier(
  config: CacheConfig,
  s3: S3Tier | undefined,
  s3ExactHit: boolean
): Promise<SaveResult> {
  if (s3ExactHit) {
    log.info(`Cache hit occurred on the primary key ${config.primaryKey}, not saving cache.`);
    getHost().setOutput(Outputs.CacheSavedSources, 'none');
    return { sources: [], outcome: 'exists' };
  }

  // A tier error the step only warned about still makes the outcome an error, not a plain skip.
  let warnedError: string | undefined;
  if (s3) {
    const outcome = await saveToS3(s3, config.primaryKey, config.paths);
    switch (outcome.kind) {
      case 'saved':
      case 'exists':
        reportS3(outcome.s3);
        getHost().setOutput(Outputs.CacheSavedSources, 's3');
        return {
          size: outcome.s3?.size,
          sources: ['s3'],
          objectKey: outcome.s3?.objectKey,
          transferMs: outcome.transferMs,
          archiveMs: outcome.archiveMs,
          outcome: outcome.kind,
        };
      case 'skipped':
        getHost().setOutput(Outputs.CacheSavedSources, 'none');
        return { sources: [], outcome: 'skipped' };
      case 'error': {
        const error = s3SaveError(outcome.error);
        log.warning(`Failed to save cache to S3: ${error.message}`);
        warnedError = error.message;
        break;
      }
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  if (config.useFallback) {
    log.info('Saving to GitHub Actions Cache instead (use-fallback).');
    // Load the GitHub tier only when a run uses it. S3-only runs skip its start-up cost.
    const { saveToGitHub } = await import('./githubTier');
    const outcome = await saveToGitHub(
      config.paths,
      config.primaryKey,
      config.uploadChunkSize,
      config.enableCrossOsArchive
    );
    switch (outcome.kind) {
      case 'saved':
        getHost().setOutput(Outputs.CacheSavedSources, 'github');
        return { sources: ['github'], outcome: 'saved' };
      case 'error':
        log.warning(`Failed to save cache to GitHub Actions Cache: ${outcome.error.message}`);
        warnedError = outcome.error.message;
        break;
      case 'exists':
      case 'skipped':
        break;
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  getHost().setOutput(Outputs.CacheSavedSources, 'none');
  return warnedError
    ? { sources: [], outcome: 'error', error: warnedError }
    : { sources: [], outcome: 'skipped' };
}

async function saveBothTiers(
  config: CacheConfig,
  s3: S3Tier | undefined,
  s3ExactHit: boolean,
  githubExactHit: boolean
): Promise<SaveResult> {
  const present = new Set<'s3' | 'github'>();
  let size: number | undefined;
  let objectKey: string | undefined;
  let transferMs: number | undefined;
  let archiveMs: number | undefined;
  // Only an upload this step actually performed makes the outcome "saved"; tiers that already
  // held the key report "exists".
  let uploaded = false;
  // A tier error the step only warned about still makes the outcome an error, not a plain skip.
  let warnedError: string | undefined;
  const tierFailed = (tier: string, error: Error): void => {
    if (config.dualCacheStrict) {
      throw new Error(`Saving to ${tier} failed: ${error.message}`, { cause: error });
    }
    log.warning(`Dual-cache ${tier} save error: ${error.message}`);
    warnedError = error.message;
  };

  log.info(`Dual-cache save (strategy: ${config.dualCacheStrategy})`);
  const skipBoth = config.dualCacheStrategy === 'skip-on-hit' && (s3ExactHit || githubExactHit);
  if (skipBoth) {
    log.info(
      'An exact hit occurred on one tier and dual-cache-strategy is skip-on-hit; not saving.'
    );
  }

  if (s3ExactHit) {
    present.add('s3');
  } else if (!skipBoth && s3) {
    const outcome = await saveToS3(s3, config.primaryKey, config.paths);
    switch (outcome.kind) {
      case 'saved':
      case 'exists':
        present.add('s3');
        reportS3(outcome.s3);
        size = outcome.s3?.size;
        objectKey = outcome.s3?.objectKey;
        transferMs = outcome.transferMs;
        archiveMs = outcome.archiveMs;
        uploaded ||= outcome.kind === 'saved';
        break;
      case 'skipped':
        break;
      case 'error':
        tierFailed('S3', s3SaveError(outcome.error));
        break;
      default: {
        const unreachable: never = outcome;
        throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  if (githubExactHit) {
    present.add('github');
  } else if (!skipBoth) {
    let alreadyThere = false;
    let githubTier: typeof import('./githubTier') | undefined;
    try {
      // Load the GitHub tier only when a run uses it. S3-only runs skip its start-up cost. A
      // failure to load the chunk is a GitHub tier failure, as is a failed existence check.
      githubTier = await import('./githubTier');
      alreadyThere = await githubTier.existsInGitHub(
        config.paths,
        config.primaryKey,
        config.enableCrossOsArchive
      );
    } catch (err) {
      tierFailed('GitHub Actions Cache', toError(err));
    }
    if (githubTier === undefined) {
      // The tier did not load, and tierFailed has warned. There is nothing to save with.
    } else if (alreadyThere) {
      log.info(
        `GitHub Actions Cache already has key "${config.primaryKey}"; not uploading it again.`
      );
      present.add('github');
    } else {
      const outcome = await githubTier.saveToGitHub(
        config.paths,
        config.primaryKey,
        config.uploadChunkSize,
        config.enableCrossOsArchive
      );
      switch (outcome.kind) {
        case 'saved':
          present.add('github');
          uploaded = true;
          break;
        case 'error':
          tierFailed('GitHub Actions Cache', outcome.error);
          break;
        case 'exists':
        case 'skipped':
          break;
        default: {
          const unreachable: never = outcome;
          throw new Error(`Unhandled save outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  const sources = (['s3', 'github'] as const).filter((source) => present.has(source));
  getHost().setOutput(Outputs.CacheSavedSources, sources.join(',') || 'none');
  log.info(`Dual-cache save complete. Cache present in: ${sources.join(', ') || 'none'}`);
  if (sources.length === 0) {
    return warnedError
      ? { sources: [], objectKey, transferMs, outcome: 'error', error: warnedError }
      : { sources: [], objectKey, transferMs, outcome: 'skipped' };
  }
  return {
    size,
    sources: [...sources],
    objectKey,
    transferMs,
    archiveMs,
    outcome: uploaded ? 'saved' : 'exists',
  };
}

export async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
  let strict = false;
  const start = Date.now();
  let config: CacheConfig | undefined;
  let provider: string | undefined;
  let compression: 'zstd' | 'gzip' | undefined;
  let region: string | undefined;
  // One line per step: a throw after the save has already reported must not report twice.
  let reported = false;
  const report = (metrics: Omit<StepMetrics, 'timestamp' | 'durationMs'>): void => {
    if (reported) {
      return;
    }
    reported = true;
    const full = {
      ...metrics,
      ...hostMetricsFields(compression, region),
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
    const timings = formatTimings(full);
    if (timings) {
      log.info(timings);
    }
    emitMetrics(full, config?.metricsFile ?? '', getHost().context().workspace);
  };
  try {
    if (!isValidEvent()) {
      log.warning(
        `Event Validation Warning: The event type ${getHost().context().eventName} may not be tied to a branch or tag ref.`
      );
    }

    // In the post step the key and the paths come from state, so the preset does not hash again.
    config = await applyPreset(readCacheConfig(stateProvider), readPreset());
    strict = config.dualCache && config.dualCacheStrict;
    // Set up front and overwritten on success, so every path — an early skip or an error
    // handled as a warning included — leaves the timing and size outputs defined.
    getHost().setOutput(Outputs.CacheSaveDurationMs, '0');
    getHost().setOutput(Outputs.CacheTransferDurationMs, '0');
    getHost().setOutput(Outputs.CacheBytes, '0');
    /** Records a save that never reached the tiers, so the metrics file still gets its line. */
    const skip = (reason: string): void => {
      report({
        step: 'save',
        key: config?.primaryKey,
        savedTo: [],
        bytes: 0,
        outcome: 'skipped',
        extra: { reason },
      });
    };
    if (config.readOnly) {
      log.info('Read-only mode enabled. Skipping cache save.');
      skip('read-only');
      return;
    }
    if (!config.primaryKey) {
      log.warning('Key is not specified. Set key and path, or set preset. Skipping cache save.');
      skip('no key');
      return;
    }
    if (config.paths.length === 0) {
      log.warning('No paths specified to cache. Set path, or set preset. Skipping save.');
      skip('no paths');
      return;
    }
    // @actions/cache skips the GitHub tier itself in these modes. Skip both tiers here, so the
    // S3 tier obeys the same mode and the step reports one skip. A skip never fails the step.
    const cacheMode = getCacheMode();
    if (!isCacheWritable(cacheMode)) {
      log.info(
        `Cache save skipped: ACTIONS_CACHE_MODE is '${cacheMode}', which does not permit writes.`
      );
      getHost().setOutput(Outputs.CacheSavedSources, 'none');
      getHost().setOutput(Outputs.CacheSaveDurationMs, String(Date.now() - start));
      skip(`ACTIONS_CACHE_MODE=${cacheMode}`);
      await writeSaveSummary({
        jobSummary: config.jobSummary,
        key: config.primaryKey,
        savedTo: [],
        durationMs: Date.now() - start,
        preset: config.preset,
        paths: config.paths,
        skipped: `ACTIONS_CACHE_MODE is ${cacheMode}`,
      });
      return;
    }

    const s3ExactHit = stateProvider.getState(State.CacheS3ExactHit) === 'true';
    const githubExactHit = stateProvider.getState(State.CacheGithubExactHit) === 'true';
    const s3 = await setUpS3(config, stateProvider);
    provider = s3?.storage.providerConfig.provider;
    compression = s3?.compression.method;
    region = s3?.storage.providerConfig.region;

    const result = config.dualCache
      ? await saveBothTiers(config, s3, s3ExactHit, githubExactHit)
      : await saveSingleTier(config, s3, s3ExactHit);
    getHost().setOutput(Outputs.CacheSaveDurationMs, String(Date.now() - start));
    getHost().setOutput(Outputs.CacheTransferDurationMs, String(result.transferMs ?? 0));
    getHost().setOutput(Outputs.CacheBytes, String(result.size ?? 0));
    report({
      step: 'save',
      provider,
      key: config.primaryKey,
      objectKey: result.objectKey,
      savedTo: result.sources,
      bytes: result.size ?? 0,
      transferDurationMs: result.transferMs ?? 0,
      archiveDurationMs: result.archiveMs,
      streaming: config.streaming,
      outcome: result.outcome,
      extra: result.error ? { error: result.error } : undefined,
    });
    await writeSaveSummary({
      jobSummary: config.jobSummary,
      key: config.primaryKey,
      savedTo: result.sources,
      size: result.size,
      durationMs: Date.now() - start,
      preset: config.preset,
      paths: config.paths,
    });
    return config.dualCache ? undefined : result.size;
  } catch (err) {
    const message = toError(err).message;
    report({
      step: 'save',
      provider,
      key: config?.primaryKey,
      savedTo: [],
      bytes: 0,
      outcome: 'error',
      extra: { error: message },
    });
    if (strict) {
      getHost().setFailed(message);
    } else {
      log.warning(`Save cache encountered error: ${message}`);
    }
  }
}

export async function runSave(earlyExit = true): Promise<void> {
  await saveImpl(getHost().state);
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}

export async function runSaveOnly(earlyExit = true): Promise<void> {
  await saveImpl(new NullStateProvider());
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
