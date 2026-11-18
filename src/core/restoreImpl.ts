import { getHost } from '../ci/host';
import { log } from '../ci/log';
import { Outputs, State } from '../constants';
import { NullStateProvider, type IStateProvider } from '../state';
import { isValidEvent } from '../utils/inputUtils';
import { getCacheMode, isCacheReadable } from './cacheMode';
import { persistCacheConfig, readCacheConfig, type CacheConfig } from './config';
import { buildExplainReport, renderExplain, writeExplainSummary } from './explain';
import { emitMetrics, hostMetricsFields, type StepMetrics } from './metrics';
import { formatTimings } from './timings';
import { toError, type RestoreOutcome } from './outcomes';
import { applyPreset, readPreset } from './presets';
import { buildS3Tier, restoreFromS3, type S3Tier } from './s3Tier';
import { writeRestoreSummary, type RestoreSummaryData } from './summary';

/** The annotation title of each restore warning, so a job with several cache steps shows which one warned. */
const WARNING_TITLE = 'Cloud cache restore';

/** Logs a warning with the restore title and returns its text, for the job summary. */
function warn(message: string): string {
  log.warning(message, WARNING_TITLE);
  return message;
}

type Source = 's3' | 'github';
type Hit = Extract<RestoreOutcome, { kind: 'hit' }>;

/** S3 alone, unless use-fallback or dual-cache adds GitHub Actions Cache. */
function restoreOrder(config: CacheConfig): Source[] {
  if (config.dualCache) {
    return config.restorePriority === 'github-first' ? ['github', 's3'] : ['s3', 'github'];
  }
  return config.useFallback ? ['s3', 'github'] : ['s3'];
}

/**
 * S3 setup errors fail the step only when no other tier may serve the restore. A warned error goes
 * to `errors`, for the job summary.
 */
async function setUpS3(
  config: CacheConfig,
  state: IStateProvider,
  errors: string[]
): Promise<S3Tier | undefined> {
  try {
    const tier = await buildS3Tier(config);
    getHost().setOutput(Outputs.CacheStorageProvider, tier.storage.providerConfig.provider);
    state.setState(State.CacheStorageProvider, tier.storage.providerConfig.provider);
    // The post step reuses this method, so zstd appearing mid-job cannot change the keys.
    state.setState(State.CacheCompression, tier.compression.method);
    return tier;
  } catch (err) {
    const otherTierMayServe = config.dualCache ? !config.dualCacheStrict : config.useFallback;
    if (!otherTierMayServe) {
      throw err;
    }
    errors.push(warn(`S3 client initialization failed: ${toError(err).message}`));
    return undefined;
  }
}

async function attempt(
  source: Source,
  config: CacheConfig,
  s3: S3Tier | undefined
): Promise<RestoreOutcome> {
  if (source === 'github') {
    log.info('Querying GitHub Actions Cache...');
    // Load the GitHub tier only when a run uses it. S3-only runs skip its start-up cost.
    const { restoreFromGitHub } = await import('./githubTier');
    return restoreFromGitHub(
      config.paths,
      config.primaryKey,
      config.restoreKeys,
      config.lookupOnly,
      config.enableCrossOsArchive
    );
  }
  if (!s3) {
    return { kind: 'miss' };
  }
  return restoreFromS3(s3, config.primaryKey, config.restoreKeys, config.lookupOnly);
}

function reportHit(state: IStateProvider, config: CacheConfig, source: Source, hit: Hit): string {
  state.setState(State.CacheMatchedKey, hit.matchedKey);
  state.setState(State.CacheHitSource, source);
  if (hit.exact) {
    state.setState(source === 's3' ? State.CacheS3ExactHit : State.CacheGithubExactHit, 'true');
  }
  if (hit.s3) {
    state.setState(State.CacheS3Key, hit.s3.objectKey);
    getHost().setOutput(Outputs.CacheS3Key, hit.s3.objectKey);
    getHost().setOutput(Outputs.CacheSize, String(hit.s3.size));
    if (hit.s3.etag) {
      getHost().setOutput(Outputs.CacheETag, hit.s3.etag);
    }
  }
  getHost().setOutput(Outputs.CacheMetadata, JSON.stringify(hit.s3?.metadata ?? {}));
  getHost().setOutput(Outputs.CacheHit, String(hit.exact));
  getHost().setOutput(Outputs.CacheMatchedKey, hit.matchedKey);
  getHost().setOutput(Outputs.CacheHitSource, source);
  log.info(
    config.lookupOnly
      ? `Cache found in ${source} and can be restored from key: ${hit.matchedKey}`
      : `Cache restored from ${source} with key: ${hit.matchedKey}`
  );
  return hit.matchedKey;
}

/**
 * The line after a normal miss: the bucket, the provider and the refs that the step searched. It
 * names no endpoint, because the R2 endpoint host holds the account ID.
 */
export function searchedLine(config: CacheConfig, s3: S3Tier | undefined): string | undefined {
  if (!s3) {
    return undefined;
  }
  const refs = s3.restoreRefs.filter((ref) => ref !== '');
  let line = `Searched s3://${s3.storage.bucket} (provider ${s3.storage.providerConfig.provider})`;
  if (refs.length > 0) {
    line += ` under ${refs.join(', then ')}`;
  }
  if (restoreOrder(config).includes('github')) {
    line += ', and GitHub Actions Cache';
  }
  line += '.';
  if (!config.explain) {
    line += ' Set explain: true to list each candidate.';
  }
  return line;
}

export async function restoreImpl(
  stateProvider: IStateProvider,
  earlyExit?: boolean
): Promise<string | undefined> {
  const start = Date.now();
  let config: CacheConfig | undefined;
  let provider: string | undefined;
  let compression: 'zstd' | 'gzip' | undefined;
  let region: string | undefined;
  // One line per step: a miss that then fails on fail-on-cache-miss must not report twice.
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
  // Tier errors that the step warned about. The job summary shows them under the table.
  const errors: string[] = [];
  // One summary per step: a miss that then fails on fail-on-cache-miss must not write two.
  let summarized = false;
  const summarize = async (
    data: Omit<RestoreSummaryData, 'jobSummary' | 'primaryKey' | 'preset' | 'paths' | 'lookupOnly'>
  ): Promise<void> => {
    if (summarized || config === undefined) {
      return;
    }
    summarized = true;
    await writeRestoreSummary({
      jobSummary: config.jobSummary,
      primaryKey: config.primaryKey,
      preset: config.preset,
      paths: config.paths,
      lookupOnly: config.lookupOnly,
      ...data,
    });
  };
  try {
    if (!isValidEvent()) {
      log.warning(
        `Event Validation Warning: The event type ${getHost().context().eventName} may not be tied to a branch or tag ref.`,
        WARNING_TITLE
      );
    }

    config = await applyPreset(readCacheConfig(), readPreset());
    if (!config.primaryKey) {
      throw new Error('Input required and not supplied: key. Set key and path, or set preset.');
    }
    if (config.paths.length === 0) {
      throw new Error('Input required and not supplied: path. Set key and path, or set preset.');
    }

    persistCacheConfig(stateProvider, config);
    getHost().setOutput(Outputs.CachePrimaryKey, config.primaryKey);
    getHost().setOutput(Outputs.CacheHit, 'false');
    getHost().setOutput(Outputs.CacheHitSource, 'none');
    getHost().setOutput(Outputs.CacheMetadata, '{}');
    // Set up front and overwritten on success, so every path — including an error handled as a
    // warning — leaves the timing and size outputs defined.
    getHost().setOutput(Outputs.CacheRestoreDurationMs, '0');
    getHost().setOutput(Outputs.CacheTransferDurationMs, '0');
    getHost().setOutput(Outputs.CacheBytes, '0');

    // @actions/cache skips the GitHub tier itself in these modes. Skip both tiers here, so the
    // S3 tier obeys the same mode and the step reports one skip.
    const cacheMode = getCacheMode();
    if (!isCacheReadable(cacheMode)) {
      log.info(
        `Cache restore skipped: ACTIONS_CACHE_MODE is '${cacheMode}', which does not permit reads.`
      );
      stateProvider.setState(State.CacheHitSource, 'none');
      getHost().setOutput(Outputs.CacheRestoreDurationMs, String(Date.now() - start));
      report({
        step: 'restore',
        key: config.primaryKey,
        source: 'none',
        bytes: 0,
        transferDurationMs: 0,
        downloadParts: 0,
        outcome: 'skipped',
        extra: { reason: `ACTIONS_CACHE_MODE=${cacheMode}` },
      });
      await summarize({
        matchedKey: undefined,
        cacheHit: false,
        source: 'none',
        size: undefined,
        durationMs: Date.now() - start,
        skipped: `ACTIONS_CACHE_MODE is ${cacheMode}`,
      });
      // The toolkit returns no key for a skipped restore, so actions/cache treats it as a miss.
      if (config.failOnCacheMiss) {
        throw new Error(
          `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${config.primaryKey}`
        );
      }
      return undefined;
    }

    const s3 = await setUpS3(config, stateProvider, errors);
    provider = s3?.storage.providerConfig.provider;
    compression = s3?.compression.method;
    region = s3?.storage.providerConfig.region;
    if (config.explain && s3) {
      try {
        const report = await buildExplainReport(s3, config);
        log.startGroup('Cache lookup explained');
        try {
          for (const line of renderExplain(report)) log.info(line);
        } finally {
          log.endGroup();
        }
        await writeExplainSummary(report, config.jobSummary);
      } catch (err) {
        log.warning(`Could not explain the cache lookup: ${toError(err).message}`, WARNING_TITLE);
      }
    }
    if (config.dualCache) {
      log.info(
        `Dual-cache enabled (priority: ${config.restorePriority}, strategy: ${config.dualCacheStrategy})`
      );
    }

    const failedTiers: string[] = [];
    for (const source of restoreOrder(config)) {
      const outcome = await attempt(source, config, s3);
      switch (outcome.kind) {
        case 'hit': {
          const matchedKey = reportHit(stateProvider, config, source, outcome);
          const bytes = outcome.s3?.size ?? 0;
          getHost().setOutput(Outputs.CacheRestoreDurationMs, String(Date.now() - start));
          getHost().setOutput(Outputs.CacheTransferDurationMs, String(outcome.transferMs ?? 0));
          getHost().setOutput(Outputs.CacheBytes, String(bytes));
          report({
            step: 'restore',
            provider,
            key: config.primaryKey,
            matchedKey,
            objectKey: outcome.s3?.objectKey,
            source,
            bytes,
            transferDurationMs: outcome.transferMs ?? 0,
            lookupDurationMs: outcome.lookupMs,
            extractDurationMs: outcome.extractMs,
            streaming: config.streaming,
            downloadParts: outcome.downloadParts ?? 0,
            outcome: 'hit',
          });
          await summarize({
            matchedKey,
            cacheHit: outcome.exact,
            source,
            size: outcome.s3?.size,
            durationMs: Date.now() - start,
            metadata: outcome.s3?.metadata,
            // A hit from the next tier still shows why the first tier did not serve it.
            errors,
          });
          return matchedKey;
        }
        case 'miss':
          break;
        case 'error':
          if (config.dualCache && config.dualCacheStrict) {
            throw new Error(`Restoring from ${source} failed: ${outcome.error.message}`, {
              cause: outcome.error,
            });
          }
          errors.push(
            warn(
              `Restoring from ${source} failed, so it counts as a cache miss: ${outcome.error.message}`
            )
          );
          failedTiers.push(source);
          break;
        default: {
          const unreachable: never = outcome;
          throw new Error(`Unhandled restore outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }

    stateProvider.setState(State.CacheHitSource, 'none');
    getHost().setOutput(Outputs.CacheRestoreDurationMs, String(Date.now() - start));
    report({
      step: 'restore',
      provider,
      key: config.primaryKey,
      source: 'none',
      bytes: 0,
      transferDurationMs: 0,
      streaming: config.streaming,
      downloadParts: 0,
      outcome: 'miss',
    });
    await summarize({
      matchedKey: undefined,
      cacheHit: false,
      source: 'none',
      size: undefined,
      durationMs: Date.now() - start,
      errors,
    });
    if (config.failOnCacheMiss) {
      throw new Error(
        `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${config.primaryKey}`
      );
    }
    const keys = [config.primaryKey, ...config.restoreKeys].join(', ');
    if (failedTiers.length > 0) {
      // A tier error is not a miss: the object can exist, and the download failed.
      const tiers =
        failedTiers.length === 1
          ? `the ${failedTiers[0]} tier failed (see the warning above)`
          : `the ${failedTiers.join(' and ')} tiers failed (see the warnings above)`;
      log.info(`No cache restored: ${tiers}. Keys searched: ${keys}`);
    } else {
      log.info(`Cache not found for input keys: ${keys}`);
      const searched = searchedLine(config, s3);
      if (searched) {
        log.info(searched);
      }
    }
    return undefined;
  } catch (err) {
    getHost().setFailed(toError(err).message);
    // A step that throws (no bucket, a strict tier error) still writes its row and the error.
    await summarize({
      cacheHit: false,
      source: 'none',
      durationMs: Date.now() - start,
      failed: true,
      errors: [...errors, toError(err).message],
    });
    report({
      step: 'restore',
      provider,
      key: config?.primaryKey,
      bytes: 0,
      outcome: 'error',
      extra: { error: toError(err).message },
    });
    if (earlyExit) {
      process.exit(1);
    }
    return undefined;
  }
}

export async function runRestore(earlyExit = true): Promise<void> {
  await restoreImpl(getHost().state, earlyExit);
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}

export async function runRestoreOnly(earlyExit = true): Promise<void> {
  await restoreImpl(new NullStateProvider(), earlyExit);
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
