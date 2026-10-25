import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOLEAN_INPUTS, type CliCommand, INPUT_DEFAULTS, MULTILINE_INPUTS } from './defaults';

export interface CliRun {
  command: CliCommand;
  /** Flag values by input name. Repeated multi-line flags are joined with a newline. */
  inputs: Record<string, string>;
  stateFile: string;
  outputsFile?: string;
  debug: boolean;
  /** The CI platform. `auto` picks Bitbucket when BITBUCKET_BUILD_NUMBER is set. */
  platform: Platform;
  /** Use CLOUD_CACHE_REF, CLOUD_CACHE_BASE_REF and CLOUD_CACHE_REPOSITORY on Bitbucket. */
  allowRefOverride: boolean;
  /** The AWS role for the Bitbucket OIDC token. */
  roleArn?: string;
  /** Save also when the Bitbucket step failed. Only the save command takes it. */
  saveOnFailure: boolean;
}

export type Platform = 'auto' | 'generic' | 'bitbucket';

const PLATFORMS: readonly Platform[] = ['auto', 'generic', 'bitbucket'];

export type CliArgs = CliRun | { help: true } | { version: true };

/** A command line that the CLI cannot run. The message is the text to print. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const COMMANDS = Object.keys(INPUT_DEFAULTS) as CliCommand[];

/** Flags of the CLI itself. Every command accepts them. */
export const CLI_FLAGS = {
  stateFile: 'state-file',
  outputsFile: 'outputs-file',
  debug: 'debug',
  platform: 'platform',
  allowRefOverride: 'allow-ref-override',
  roleArn: 'role-arn',
  saveOnFailure: 'save-on-failure',
} as const;

function isCommand(value: string): value is CliCommand {
  return (COMMANDS as string[]).includes(value);
}

function parseBool(flag: string, value: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new UsageError(`--${flag} takes true or false, not "${value}"`);
}

const CLI_BOOLEAN_FLAGS = new Set<string>([
  CLI_FLAGS.debug,
  CLI_FLAGS.allowRefOverride,
  CLI_FLAGS.saveOnFailure,
]);

function parsePlatform(value: string): Platform {
  const found = PLATFORMS.find((platform) => platform === value);
  if (found === undefined) {
    throw new UsageError(`--platform takes ${PLATFORMS.join(', ')}, not "${value}"`);
  }
  return found;
}

function envBool(value: string | undefined): boolean {
  return value !== undefined && ['true', '1'].includes(value.trim().toLowerCase());
}

/**
 * Parses the CLI arguments. Input env vars (`CLOUD_CACHE_<INPUT>`) are not read here: the host
 * reads them, so a flag wins over an env var. Only the CLI flags read their env vars here.
 */
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    return { help: true };
  }
  if (argv.includes('--version')) {
    return { version: true };
  }
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new UsageError('no command');
  }
  if (!isCommand(command)) {
    throw new UsageError(`unknown command ${command}`);
  }
  const defaults = INPUT_DEFAULTS[command];

  const inputs: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let stateFile: string | undefined;
  let outputsFile: string | undefined;
  let debug: boolean | undefined;
  let platform: string | undefined;
  let allowRefOverride: boolean | undefined;
  let roleArn: string | undefined;
  let saveOnFailure: boolean | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      throw new UsageError(`unexpected argument ${arg}`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === CLI_FLAGS.saveOnFailure && command !== 'save') {
      throw new UsageError(`--${name} is not a flag of the ${command} command`);
    }
    if (
      name === CLI_FLAGS.debug ||
      name === CLI_FLAGS.allowRefOverride ||
      name === CLI_FLAGS.saveOnFailure ||
      BOOLEAN_INPUTS.has(name)
    ) {
      if (!CLI_BOOLEAN_FLAGS.has(name) && !(name in defaults)) {
        throw unknownFlag(name, command);
      }
      const value = parseBool(name, inline ?? 'true');
      if (name === CLI_FLAGS.debug) {
        debug = value;
      } else if (name === CLI_FLAGS.allowRefOverride) {
        allowRefOverride = value;
      } else if (name === CLI_FLAGS.saveOnFailure) {
        saveOnFailure = value;
      } else {
        setOnce(inputs, name, String(value));
      }
      continue;
    }

    const isCliFlag =
      name === CLI_FLAGS.stateFile ||
      name === CLI_FLAGS.outputsFile ||
      name === CLI_FLAGS.platform ||
      name === CLI_FLAGS.roleArn;
    if (!isCliFlag && !(name in defaults)) {
      throw unknownFlag(name, command);
    }
    let value = inline;
    if (value === undefined) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      value = next;
      i++;
    }
    if (name === CLI_FLAGS.stateFile) {
      stateFile = value;
    } else if (name === CLI_FLAGS.outputsFile) {
      outputsFile = value;
    } else if (name === CLI_FLAGS.platform) {
      platform = value;
    } else if (name === CLI_FLAGS.roleArn) {
      roleArn = value;
    } else if (MULTILINE_INPUTS.has(name)) {
      lists[name] = [...(lists[name] ?? []), value];
    } else {
      setOnce(inputs, name, value);
    }
  }

  for (const [name, values] of Object.entries(lists)) {
    inputs[name] = values.join('\n');
  }

  return {
    command,
    inputs,
    stateFile:
      stateFile ?? (env.CLOUD_CACHE_STATE_FILE || join(tmpdir(), 'cloud-cache-state.json')),
    outputsFile: outputsFile ?? (env.CLOUD_CACHE_OUTPUTS_FILE || undefined),
    debug: debug ?? envBool(env.CLOUD_CACHE_DEBUG),
    platform: parsePlatform(platform ?? (env.CLOUD_CACHE_PLATFORM || 'auto')),
    allowRefOverride: allowRefOverride ?? envBool(env.CLOUD_CACHE_ALLOW_REF_OVERRIDE),
    roleArn: roleArn ?? (env.CLOUD_CACHE_ROLE_ARN || undefined),
    saveOnFailure:
      command === 'save' && (saveOnFailure ?? envBool(env.CLOUD_CACHE_SAVE_ON_FAILURE)),
  };
}

function setOnce(inputs: Record<string, string>, name: string, value: string): void {
  if (name in inputs) {
    throw new UsageError(`--${name} is given more than once`);
  }
  inputs[name] = value;
}

function unknownFlag(name: string, command: CliCommand): UsageError {
  if (COMMANDS.some((other) => name in INPUT_DEFAULTS[other])) {
    return new UsageError(`--${name} is not a flag of the ${command} command`);
  }
  return new UsageError(`unknown flag --${name}`);
}

const SYNOPSIS = [
  'Usage: cloud-cache <command> [flags]',
  '',
  'Commands:',
  '  restore   Restore a cache, and save its state for a later save.',
  '  save      Save a cache. After a restore, read the state of that restore.',
  '  inspect   Show which cache a restore would pick. Download nothing.',
  '  prune     Delete old caches.',
];

/** The short usage text that follows a usage error. */
export function shortUsage(): string {
  return [...SYNOPSIS, '', 'Run cloud-cache --help to see the flags of each command.', ''].join(
    '\n'
  );
}

/** The help text. */
export function usage(): string {
  const lines = [
    ...SYNOPSIS,
    '',
    'Each command runs one step of cloud-cache-action. The flags have the names of the action',
    'inputs.',
    '',
    'Flags of every command:',
    `  --${CLI_FLAGS.stateFile} <path>    The state file that restore writes and save reads.`,
    `                         Env: CLOUD_CACHE_STATE_FILE. Default: <tmpdir>/cloud-cache-state.json`,
    `  --${CLI_FLAGS.outputsFile} <path>  Append each output as name=value. A value with a newline`,
    '                         uses the name<<delimiter form. Env: CLOUD_CACHE_OUTPUTS_FILE',
    `  --${CLI_FLAGS.debug}                Print debug messages. Env: CLOUD_CACHE_DEBUG`,
    `  --${CLI_FLAGS.platform} <value>     auto, generic or bitbucket. Env: CLOUD_CACHE_PLATFORM.`,
    '                         Default: auto. It picks bitbucket when BITBUCKET_BUILD_NUMBER is set.',
    `  --${CLI_FLAGS.allowRefOverride}[=true|false]`,
    '                         On bitbucket, use CLOUD_CACHE_REF, CLOUD_CACHE_BASE_REF and',
    '                         CLOUD_CACHE_REPOSITORY. Env: CLOUD_CACHE_ALLOW_REF_OVERRIDE',
    `  --${CLI_FLAGS.roleArn} <arn>       The AWS role for the Bitbucket OIDC token.`,
    '                         Env: CLOUD_CACHE_ROLE_ARN',
    `  --${CLI_FLAGS.saveOnFailure}[=true|false]`,
    '                         (save only) On bitbucket, save also when the step failed.',
    '                         Env: CLOUD_CACHE_SAVE_ON_FAILURE',
    '  --help                 Print this text.',
    '  --version              Print the version.',
  ];
  for (const command of COMMANDS) {
    lines.push('', `Flags of ${command}:`);
    for (const [name, value] of Object.entries(INPUT_DEFAULTS[command])) {
      const flag = BOOLEAN_INPUTS.has(name) ? `--${name}[=true|false]` : `--${name} <value>`;
      const notes = [
        ...(MULTILINE_INPUTS.has(name) ? ['repeatable'] : []),
        ...(value === '' ? [] : [`default: ${value}`]),
      ];
      lines.push(`  ${flag}${notes.length ? `  (${notes.join(', ')})` : ''}`);
    }
  }
  lines.push(
    '',
    'Environment:',
    '  An unset flag reads CLOUD_CACHE_<INPUT>: the input name in upper case, with "-" as "_".',
    '  For example, --restore-keys reads CLOUD_CACHE_RESTORE_KEYS. A flag wins over the env var,',
    '  and the env var wins over the default.',
    '  CLOUD_CACHE_REPOSITORY, CLOUD_CACHE_REF, CLOUD_CACHE_BASE_REF and CLOUD_CACHE_DEFAULT_BRANCH',
    '  set the repository and the refs that go into the cache keys. On bitbucket, the first three',
    '  have an effect only with --allow-ref-override or CLOUD_CACHE_ALLOW_REF_OVERRIDE=true.',
    '  CLOUD_CACHE_PLATFORM, CLOUD_CACHE_ALLOW_REF_OVERRIDE, CLOUD_CACHE_ROLE_ARN and',
    '  CLOUD_CACHE_SAVE_ON_FAILURE are the env vars of the flags --platform, --allow-ref-override,',
    '  --role-arn and --save-on-failure.',
    ''
  );
  return lines.join('\n');
}
