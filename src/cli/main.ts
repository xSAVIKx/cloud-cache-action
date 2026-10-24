import { GenericHost } from '../ci/generic';
import { setHost } from '../ci/host';
import { FileStateProvider } from '../ci/stateFile';
import { inspectImpl } from '../core/inspectImpl';
import { pruneImpl } from '../core/pruneImpl';
import { restoreImpl } from '../core/restoreImpl';
import { saveImpl } from '../core/saveImpl';
import { type CliArgs, type CliRun, parseCliArgs, shortUsage, UsageError, usage } from './args';
import { INPUT_DEFAULTS } from './defaults';
import { checkTar } from './tarCheck';
import { CLI_VERSION } from './version';

/** Exit code of a command line that the CLI cannot run. */
const USAGE_EXIT_CODE = 2;

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
    case 'restore':
      await checkTar();
      await restoreImpl(new FileStateProvider(args.stateFile), false);
      return;
    case 'save':
      await checkTar();
      await saveImpl(new FileStateProvider(args.stateFile));
      return;
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
