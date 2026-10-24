import { GitHubActionsHost } from '../ci/github';
import { getHost } from '../ci/host';
import { log } from '../ci/log';
import { Defaults, Inputs, Outputs } from '../constants';
import { createStorageContext } from '../storage/client';
import {
  getInputAsBool,
  getInputAsInt,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
} from '../utils/inputUtils';
import { compileKeyTemplate } from './keyTemplate';
import { emitMetrics } from './metrics';
import { toError } from './outcomes';
import { pruneCaches, type PruneTier } from './prune';
import { NO_RULE_MESSAGE, hasPruneRule, type PruneRules } from './pruneSelect';

const TRUE_VALUES = ['true', 'True', 'TRUE'];
const FALSE_VALUES = ['false', 'False', 'FALSE'];

/** Every input the prune step reads. `ref` empty means every ref. */
export interface PruneConfig {
  /** The rules (age, keep-latest, size budget, stale uploads). Each one is optional. */
  rules: PruneRules;
  ref: string;
  dryRun: boolean;
  prefix: string;
  s3KeyPattern: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  retryEnabled: boolean;
  retryCount: number;
  /** Workspace-relative file that gets one JSON line of metrics; '' disables it. */
  metricsFile: string;
}

/**
 * Unlike `getInputAsBool`, which warns and falls back to a default on an unrecognized value,
 * an unrecognized `dry-run` value must fail the step: silently treating it as `false` would
 * turn a typo (e.g. "Flase") into a real, unintended deletion.
 */
function parseDryRun(raw: string): boolean {
  if (raw === '') {
    return false;
  }
  if (TRUE_VALUES.includes(raw)) {
    return true;
  }
  if (FALSE_VALUES.includes(raw)) {
    return false;
  }
  throw new Error(`Invalid "dry-run" value "${raw}": use true or false.`);
}

/**
 * Reads the selection rules. To add a rule, add its input here and its logic in `./pruneSelect`.
 * `max-total-size` is a plain integer in bytes (0 allowed): the code has no size parser.
 */
export function readPruneRules(): PruneRules {
  const rules: PruneRules = {
    olderThanDays: parseOptionalPositiveInt(
      getHost().input(Inputs.OlderThanDays),
      Inputs.OlderThanDays
    ),
    keepLatest: parseOptionalPositiveInt(getHost().input(Inputs.KeepLatest), Inputs.KeepLatest),
    maxTotalSize: parseOptionalNonNegativeInt(
      getHost().input(Inputs.MaxTotalSize),
      Inputs.MaxTotalSize
    ),
    abortUploadsOlderThanHours: parseOptionalPositiveInt(
      getHost().input(Inputs.AbortUploadsOlderThanHours),
      Inputs.AbortUploadsOlderThanHours
    ),
  };
  if (!hasPruneRule(rules)) {
    throw new Error(NO_RULE_MESSAGE);
  }
  return rules;
}

export function readPruneConfig(): PruneConfig {
  return {
    rules: readPruneRules(),
    ref: getHost().input(Inputs.Ref).trim(),
    dryRun: parseDryRun(getHost().input(Inputs.DryRun)),
    prefix: getHost().input(Inputs.Prefix),
    s3KeyPattern: getHost().input(Inputs.S3KeyPattern) || Defaults.DefaultS3KeyPattern,
    scopedToRepository: getInputAsBool(Inputs.ScopedToRepository, true),
    scopedToRef: getInputAsBool(Inputs.ScopedToRef, true),
    retryEnabled: getInputAsBool(Inputs.Retry, true),
    retryCount: getInputAsInt(Inputs.RetryCount) ?? Defaults.DefaultRetryCount,
    metricsFile: getHost().input(Inputs.MetricsFile).trim(),
  };
}

/**
 * Builds the storage/template pair pruning needs. No version or archive-format concern applies:
 * the template is compiled with an empty version and the zstd archive filename, and `./prune`
 * matches saved objects through `KeyTemplate.scopeMatcher`, which accepts any version and both
 * known archive filenames.
 */
export function buildPruneTier(config: PruneConfig, env?: NodeJS.ProcessEnv): PruneTier {
  // process.env is the live environment, so it means "the CI host of this run". Any other env
  // object is a test or caller fixture, read as GitHub variables.
  const ctx =
    env === undefined || env === process.env
      ? getHost().context()
      : new GitHubActionsHost(env).context();
  const storage = createStorageContext({
    maxAttempts: config.retryEnabled ? config.retryCount + 1 : 1,
  });
  const template = compileKeyTemplate({
    pattern: config.s3KeyPattern,
    repository: ctx.repository,
    prefix: config.prefix,
    scopedToRepository: config.scopedToRepository,
    scopedToRef: config.scopedToRef,
    version: '',
    archiveFilename: Defaults.DefaultArchiveFilenameZstd,
    env: ctx.env,
  });
  for (const warning of template.warnings) {
    log.warning(warning);
  }
  return { storage, template };
}

export async function pruneImpl(): Promise<void> {
  const start = Date.now();
  try {
    const config = readPruneConfig();
    if (config.ref && !config.scopedToRef) {
      throw new Error(
        'Refusing to prune: "ref" is set but "scoped-to-ref" is false, so cache keys contain no ref.'
      );
    }
    if (config.ref && !config.ref.startsWith('refs/')) {
      log.warning(
        `The "ref" input "${config.ref}" is not a full Git ref. Prune expects a full ref such as refs/heads/main, so it may match no caches.`
      );
    }

    const tier = buildPruneTier(config);
    const result = await pruneCaches(tier, {
      ...config.rules,
      ref: config.ref || undefined,
      dryRun: config.dryRun,
    });

    getHost().setOutput(Outputs.PrunedCount, String(result.pruned.length));
    getHost().setOutput(Outputs.PrunedBytes, String(result.prunedBytes));
    getHost().setOutput(Outputs.KeptCount, String(result.keptCount));
    getHost().setOutput(Outputs.AbortedUploads, String(result.abortedUploads));
    emitMetrics(
      {
        step: 'prune',
        timestamp: new Date().toISOString(),
        provider: tier.storage.providerConfig.provider,
        bytes: result.prunedBytes,
        durationMs: Date.now() - start,
        outcome: 'pruned',
        extra: {
          prunedCount: result.pruned.length,
          prunedBytes: result.prunedBytes,
          keptCount: result.keptCount,
          abortedUploads: result.abortedUploads,
          dryRun: result.dryRun,
        },
      },
      config.metricsFile,
      getHost().context().workspace
    );
  } catch (err) {
    getHost().setFailed(toError(err).message);
  }
}

export async function runPrune(earlyExit = true): Promise<void> {
  await pruneImpl();
  if (earlyExit) {
    // An explicit exit code overrides process.exitCode, so keep the one core.setFailed set.
    process.exit(process.exitCode ?? 0);
  }
}
