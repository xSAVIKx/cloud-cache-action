import { appendFileSync } from 'node:fs';
import { refCandidates } from '../core/refs';
import { runnerOs } from './env';
import {
  GenericHost,
  type GenericHostOptions,
  osHomeDir,
  toBranchName,
  toFullRef,
} from './generic';
import type { CiContext } from './host';
import { type RunnerLabels, runnerLabels } from './runnerLabels';
import { TextSummaryWriter } from './textSummary';

const DEFAULT_BRANCH = 'main';

export interface BitbucketHostOptions extends GenericHostOptions {
  /** Use CLOUD_CACHE_REF, CLOUD_CACHE_BASE_REF and CLOUD_CACHE_REPOSITORY. Off by default. */
  allowRefOverride?: boolean;
}

/** The host for Bitbucket Pipelines. It reads the run from BITBUCKET_* variables. */
export class BitbucketHost extends GenericHost {
  override readonly summary = new TextSummaryWriter();

  private readonly allowRefOverride: boolean;

  private labels: RunnerLabels | undefined;

  private contextLogged = false;

  private emptyRepositoryWarned = false;

  constructor(options: BitbucketHostOptions) {
    super(options);
    this.allowRefOverride = options.allowRefOverride === true;
  }

  override context(): CiContext {
    const env = this.env;
    const overrides = (
      ['CLOUD_CACHE_REF', 'CLOUD_CACHE_BASE_REF', 'CLOUD_CACHE_REPOSITORY'] as const
    ).filter((name) => (env[name] ?? '') !== '');
    const useOverride = this.allowRefOverride;

    const repository =
      (useOverride ? env.CLOUD_CACHE_REPOSITORY : undefined) || env.BITBUCKET_REPO_FULL_NAME || '';
    if (repository === '' && !this.emptyRepositoryWarned) {
      this.emptyRepositoryWarned = true;
      if (this.input('scoped-to-repository') !== 'false') {
        this.log.warning(
          'BITBUCKET_REPO_FULL_NAME is empty, so the cache keys have no repository part. ' +
            'Caches of all repositories that use this bucket and prefix are shared.'
        );
      }
    }

    const pullRequestId = env.BITBUCKET_PR_ID || undefined;
    let current: string | undefined;
    if (env.BITBUCKET_TAG) {
      current = `refs/tags/${env.BITBUCKET_TAG}`;
    } else if (pullRequestId) {
      current = `refs/pull/${pullRequestId}/merge`;
    } else {
      current = toFullRef(env.BITBUCKET_BRANCH);
    }
    let baseRef = pullRequestId ? toBranchName(env.BITBUCKET_PR_DESTINATION_BRANCH) : undefined;
    if (useOverride) {
      current = toFullRef(env.CLOUD_CACHE_REF) ?? current;
      baseRef = toBranchName(env.CLOUD_CACHE_BASE_REF) ?? baseRef;
    }
    const configuredDefault = toBranchName(env.CLOUD_CACHE_DEFAULT_BRANCH);
    const defaultBranch = configuredDefault || DEFAULT_BRANCH;

    if (!this.contextLogged) {
      this.contextLogged = true;
      this.log.info(
        configuredDefault
          ? `Default branch: ${configuredDefault}`
          : `Default branch: ${DEFAULT_BRANCH} (set CLOUD_CACHE_DEFAULT_BRANCH to change it)`
      );
      if (overrides.length > 0) {
        if (useOverride) {
          this.log.info(
            `Ref override is on. Values taken from the environment: ${overrides.map((name) => `${name}=${env[name]}`).join(', ')}.`
          );
        } else {
          this.log.warning(
            `${overrides.join(', ')} ignored on Bitbucket. ` +
              'Set --allow-ref-override or CLOUD_CACHE_ALLOW_REF_OVERRIDE=true to use them.'
          );
        }
      }
    }

    return {
      platform: 'bitbucket',
      repository,
      refs: refCandidates({ current, baseRef, defaultBranch }),
      eventName: pullRequestId ? 'pull_request' : 'push',
      workspace: env.BITBUCKET_CLONE_DIR || env.CLOUD_CACHE_WORKSPACE || process.cwd(),
      homeDir: env.HOME || env.USERPROFILE || osHomeDir(),
      runnerOs: runnerOs(env),
      labels: (this.labels ??= runnerLabels(env)),
      env,
    };
  }

  override setOutput(name: string, value: unknown): void {
    super.setOutput(name, value);
    const file = this.env.BITBUCKET_PIPELINES_VARIABLES_PATH;
    if (!file) {
      return;
    }
    const text =
      value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    if (text.includes('\n') || text.includes('\r')) {
      this.log.debug(`Output ${name} has a newline, so it is not added to the variables file.`);
      return;
    }
    const variable = `CLOUD_CACHE_${name.toUpperCase().replace(/-/g, '_')}`;
    try {
      appendFileSync(file, `${variable}=${text}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot write the variables file ${file}: ${reason}`, { cause: error });
    }
  }
}
