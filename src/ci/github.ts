import * as os from 'node:os';
import * as core from '@actions/core';
import { getWorkspace, runnerOs } from './env';
import { resolveRefCandidates } from '../core/refs';
import { type IStateProvider, StateProvider } from '../state';
import type { CiContext, CiHost, CiLogger, InputOptions, SummaryWriter } from './host';

/** The home directory of the OS user, or '' when the user has no passwd entry. */
function osHomeDir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

/** The host for GitHub Actions. It calls `core` only when a method runs, never when it loads. */
export class GitHubActionsHost implements CiHost {
  readonly state: IStateProvider = new StateProvider();

  readonly log: CiLogger = {
    debug: (message) => core.debug(message),
    info: (message) => core.info(message),
    warning: (message) => core.warning(message),
    error: (message) => core.error(message),
    startGroup: (title) => core.startGroup(title),
    endGroup: () => core.endGroup(),
  };

  constructor(private readonly fixedEnv?: NodeJS.ProcessEnv) {}

  private get env(): NodeJS.ProcessEnv {
    return this.fixedEnv ?? process.env;
  }

  context(): CiContext {
    const env = this.env;
    return {
      platform: 'github',
      repository: env.GITHUB_REPOSITORY ?? '',
      refs: resolveRefCandidates(env),
      eventName: env.GITHUB_EVENT_NAME,
      workspace: getWorkspace(env),
      homeDir: env.HOME || env.USERPROFILE || osHomeDir(),
      runnerOs: runnerOs(env),
      env,
    };
  }

  input(name: string, options?: InputOptions): string {
    return core.getInput(name, options);
  }

  setOutput(name: string, value: unknown): void {
    core.setOutput(name, value);
  }

  setFailed(message: string | Error): void {
    core.setFailed(message);
  }

  get summary(): SummaryWriter | undefined {
    return this.env.GITHUB_STEP_SUMMARY ? core.summary : undefined;
  }
}
