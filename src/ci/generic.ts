import { appendFileSync } from 'node:fs';
import * as os from 'node:os';
import { refCandidates } from '../core/refs';
import type { IStateProvider } from '../state';
import { runnerOs } from './env';
import type { CiContext, CiHost, CiLogger, InputOptions, SummaryWriter } from './host';
import { formatOutput } from './outputsFile';
import { FileStateProvider } from './stateFile';

export interface GenericHostOptions {
  /** Parsed flags, already joined: input name to value. */
  inputs: Record<string, string>;
  /** The default value of each input. */
  defaults: Record<string, string>;
  /** The environment. It is read at each call. */
  env?: NodeJS.ProcessEnv;
  /** The path of the JSON state file. */
  stateFile: string;
  /** The path of the outputs file. Without it, outputs are only printed. */
  outputsFile?: string;
  debug?: boolean;
}

/** The home directory of the OS user, or '' when the user has no passwd entry. */
function osHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** A bare branch name becomes a full ref. */
function toFullRef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith('refs/') ? trimmed : `refs/heads/${trimmed}`;
}

/** A branch name without a leading refs/heads/. Other values pass through: only branches are valid. */
function toBranchName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed;
}

/**
 * Env vars that hold the CI context, not an input. An input with the same env name (for example
 * the prune input `ref`) reads only its flag, so the context of the run cannot set it.
 */
const CONTEXT_ENV_NAMES: ReadonlySet<string> = new Set([
  'CLOUD_CACHE_REF',
  'CLOUD_CACHE_REPOSITORY',
  'CLOUD_CACHE_BASE_REF',
  'CLOUD_CACHE_DEFAULT_BRANCH',
  'CLOUD_CACHE_WORKSPACE',
  'CLOUD_CACHE_EVENT_NAME',
]);

/** The host for the cloud-cache CLI. It reads inputs from flags, then env, then defaults. */
export class GenericHost implements CiHost {
  readonly state: IStateProvider;

  readonly log: CiLogger;

  private repositoryWarned = false;

  constructor(private readonly options: GenericHostOptions) {
    this.state = new FileStateProvider(options.stateFile);
    this.log = {
      debug: (message) => {
        if (this.options.debug) {
          process.stdout.write(`debug: ${message}\n`);
        }
      },
      info: (message) => process.stdout.write(`${message}\n`),
      warning: (message) => process.stderr.write(`warning: ${message}\n`),
      error: (message) => process.stderr.write(`error: ${message}\n`),
      startGroup: (title) => process.stdout.write(`▶ ${title}\n`),
      endGroup: () => {},
    };
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  context(): CiContext {
    const env = this.env;
    const repository = env.CLOUD_CACHE_REPOSITORY ?? '';
    if (repository === '' && !this.repositoryWarned) {
      this.repositoryWarned = true;
      if (this.input('scoped-to-repository') !== 'false') {
        this.log.warning(
          'CLOUD_CACHE_REPOSITORY is empty, so the cache keys have no repository part. ' +
            'Caches of all repositories that use this bucket and prefix are shared.'
        );
      }
    }
    return {
      platform: 'generic',
      repository,
      refs: refCandidates({
        current: toFullRef(env.CLOUD_CACHE_REF),
        baseRef: toBranchName(env.CLOUD_CACHE_BASE_REF),
        defaultBranch: toBranchName(env.CLOUD_CACHE_DEFAULT_BRANCH),
      }),
      eventName: env.CLOUD_CACHE_EVENT_NAME ?? 'cli',
      workspace: env.CLOUD_CACHE_WORKSPACE || process.cwd(),
      homeDir: env.HOME || env.USERPROFILE || osHomeDir(),
      runnerOs: runnerOs(env),
      env,
    };
  }

  input(name: string, options?: InputOptions): string {
    const envName = `CLOUD_CACHE_${name.toUpperCase().replace(/-/g, '_')}`;
    const fromEnv = CONTEXT_ENV_NAMES.has(envName) ? undefined : this.env[envName];
    const value = this.options.inputs[name] ?? fromEnv ?? this.options.defaults[name] ?? '';
    if (options?.required && value === '') {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return options?.trimWhitespace === false ? value : value.trim();
  }

  setOutput(name: string, value: unknown): void {
    const text =
      value === undefined || value === null
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    this.log.info(`${name}=${text}`);
    const file = this.options.outputsFile;
    if (file) {
      try {
        appendFileSync(file, formatOutput(name, text));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot write the outputs file ${file}: ${reason}`, { cause: error });
      }
    }
  }

  setFailed(message: string | Error): void {
    process.exitCode = 1;
    this.log.error(message instanceof Error ? message.message : message);
  }

  readonly summary: SummaryWriter | undefined = undefined;
}
