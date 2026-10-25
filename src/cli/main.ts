import { BitbucketHost } from '../ci/bitbucket';
import { setupBitbucketOidc } from '../ci/bitbucketOidc';
import { GenericHost } from '../ci/generic';
import { getHost, setHost } from '../ci/host';
import { FileStateProvider } from '../ci/stateFile';
import { State } from '../constants';
import { inspectImpl } from '../core/inspectImpl';
import { pruneImpl } from '../core/pruneImpl';
import { restoreImpl } from '../core/restoreImpl';
import { saveImpl } from '../core/saveImpl';
import { getInputAsArray } from '../utils/inputUtils';
import { type CliArgs, type CliRun, parseCliArgs, shortUsage, UsageError, usage } from './args';
import { INPUT_DEFAULTS } from './defaults';
import { expandHashTemplates } from './hashTemplate';
import { checkTar } from './tarCheck';
import { CLI_VERSION } from './version';

/** Exit code of a command line that the CLI cannot run. */
const USAGE_EXIT_CODE = 2;

/** The paths in the state file, or undefined when the state has none. */
function statePaths(state: FileStateProvider): string[] | undefined {
  const text = state.getState(State.CachePaths);
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save takes the key and the paths from the state that restore wrote, as the action does. A key or
 * paths that the user gives to save and that differ from the state have no effect, so warn.
 */
function warnOnStateMismatch(state: FileStateProvider, stateFile: string): void {
  const stateKey = state.getState(State.CachePrimaryKey);
  if (stateKey === '') {
    return;
  }
  const host = getHost();
  const wins = `The state from restore wins. Run restore with the same state file first.`;
  const key = host.input('key');
  if (key !== '' && key !== stateKey) {
    host.log.warning(
      `The key ${key} differs from the key ${stateKey} in the state file ${stateFile}. ${wins}`
    );
  }
  const paths = getInputAsArray('path');
  const fromState = statePaths(state);
  if (paths.length > 0 && fromState && paths.join('\n') !== fromState.join('\n')) {
    host.log.warning(
      `The paths ${paths.join(', ')} differ from the paths ${fromState.join(', ')} in the state file ${stateFile}. ${wins}`
    );
  }
}

/**
 * Expands the {hash:} templates in key and restore-keys. The value comes from the flag, else from
 * the environment. It returns the expanded values and the templates that matched no file.
 */
async function expandKeyInputs(
  inputs: Record<string, string>,
  workspace: string,
  onDebug: (text: string) => void
): Promise<{ inputs: Record<string, string>; unmatched: string[] }> {
  const out = { ...inputs };
  const unmatched: string[] = [];
  const sources: Array<[string, string]> = [
    ['key', 'CLOUD_CACHE_KEY'],
    ['restore-keys', 'CLOUD_CACHE_RESTORE_KEYS'],
  ];
  for (const [name, envName] of sources) {
    const value = inputs[name] ?? process.env[envName];
    if (value === undefined || !value.includes('{hash:')) {
      continue;
    }
    const lines: string[] = [];
    for (const line of value.split('\n')) {
      const expanded = await expandHashTemplates(line, workspace, onDebug);
      lines.push(expanded.text);
      unmatched.push(...expanded.unmatched);
    }
    out[name] = lines.join('\n');
  }
  return { inputs: out, unmatched };
}

/** The platform that runs the command. */
function resolvePlatform(args: CliRun): 'generic' | 'bitbucket' {
  if (args.platform !== 'auto') {
    return args.platform;
  }
  return process.env.BITBUCKET_BUILD_NUMBER ? 'bitbucket' : 'generic';
}

/** True when the Bitbucket step failed and the user did not ask to save anyway. */
function skipSave(args: CliRun, platform: string): boolean {
  if (args.command !== 'save' || platform !== 'bitbucket' || args.saveOnFailure) {
    return false;
  }
  const exitCode = process.env.BITBUCKET_EXIT_CODE;
  return exitCode !== undefined && exitCode !== '' && exitCode !== '0';
}

async function run(args: CliRun): Promise<void> {
  const platform = resolvePlatform(args);
  let defaults: Record<string, string> = INPUT_DEFAULTS[args.command];
  if (platform === 'bitbucket' && 'metrics-file' in defaults) {
    defaults = { ...defaults, 'metrics-file': 'cloud-cache-metrics.jsonl' };
  }
  // The host reads this record on each input() call, so the expanded values go in after the build.
  const inputs = { ...args.inputs };
  const options = {
    inputs,
    defaults,
    stateFile: args.stateFile,
    outputsFile: args.outputsFile,
    debug: args.debug,
  };
  // The engine reads the host through getHost(), so the host must be set before any engine call.
  setHost(
    platform === 'bitbucket'
      ? new BitbucketHost({ ...options, allowRefOverride: args.allowRefOverride })
      : new GenericHost(options)
  );
  const host = getHost();

  if (skipSave(args, platform)) {
    host.log.info(
      `The step failed (BITBUCKET_EXIT_CODE=${process.env.BITBUCKET_EXIT_CODE}), so save is skipped. ` +
        'Use --save-on-failure to save anyway.'
    );
    return;
  }

  const workspace = host.context().workspace;
  const expanded = await expandKeyInputs(inputs, workspace, (text) => host.log.debug(text));
  Object.assign(inputs, expanded.inputs);
  for (const glob of expanded.unmatched) {
    host.log.warning(`The {hash:${glob}} template matched no file under ${workspace}.`);
  }

  const oidc =
    platform === 'bitbucket'
      ? setupBitbucketOidc({
          env: process.env,
          roleArn: args.roleArn,
          hasAccessKey:
            host.input('access-key') !== '' ||
            host.input('accessKey') !== '' ||
            !!process.env.AWS_ACCESS_KEY_ID,
          log: host.log,
        })
      : undefined;
  try {
    await runCommand(args);
  } finally {
    oidc?.cleanup();
  }
}

async function runCommand(args: CliRun): Promise<void> {
  switch (args.command) {
    case 'restore': {
      await checkTar();
      // Save trusts the state of the last restore, so a restore must not keep an older hit.
      const state = new FileStateProvider(args.stateFile);
      state.reset();
      await restoreImpl(state, false);
      return;
    }
    case 'save': {
      await checkTar();
      const state = new FileStateProvider(args.stateFile);
      warnOnStateMismatch(state, args.stateFile);
      await saveImpl(state);
      return;
    }
    case 'inspect':
      await inspectImpl();
      return;
    case 'prune':
      await pruneImpl();
      return;
  }
}

/** Prints an unexpected error and returns the exit code 1. */
function reportError(error: unknown): number {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

/** Runs the CLI and returns the exit code. It does not call process.exit. */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n\n${shortUsage()}`);
      return USAGE_EXIT_CODE;
    }
    return reportError(error);
  }
  if ('help' in args) {
    process.stdout.write(usage());
    return 0;
  }
  if ('version' in args) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  process.exitCode = undefined;
  try {
    await run(args);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      return USAGE_EXIT_CODE;
    }
    return reportError(error);
  }
  // A host sets process.exitCode when the step fails (setFailed).
  return Number(process.exitCode ?? 0);
}
