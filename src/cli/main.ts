import { GenericHost } from '../ci/generic';
import { getHost, setHost } from '../ci/host';
import { FileStateProvider } from '../ci/stateFile';
import { inspectImpl } from '../core/inspectImpl';
import { pruneImpl } from '../core/pruneImpl';
import { restoreImpl } from '../core/restoreImpl';
import { saveImpl } from '../core/saveImpl';
import { State } from '../constants';
import { getInputAsArray } from '../utils/inputUtils';
import { type CliArgs, type CliRun, parseCliArgs, shortUsage, UsageError, usage } from './args';
import { INPUT_DEFAULTS } from './defaults';
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

async function run(args: CliRun): Promise<void> {
  // The engine reads the host through getHost(), so the host must be set before any engine call.
  setHost(
    new GenericHost({
      inputs: args.inputs,
      defaults: INPUT_DEFAULTS[args.command],
      stateFile: args.stateFile,
      outputsFile: args.outputsFile,
      debug: args.debug,
    })
  );
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
    return reportError(error);
  }
  // A host sets process.exitCode when the step fails (setFailed).
  return Number(process.exitCode ?? 0);
}
