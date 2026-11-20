import { CLI_FLAGS } from './args';
import { BOOLEAN_INPUTS, type CliCommand, INPUT_DEFAULTS, MULTILINE_INPUTS } from './defaults';
import { FLAG_DESCRIPTIONS } from './flagDescriptions';

/** The purpose of each command. The command list of `cloud-cache --help` has the same text. */
export const COMMAND_SUMMARIES: Record<CliCommand, string> = {
  restore: 'Restore a cache, and save its state for a later save.',
  save: 'Save a cache. After a restore, read the state of that restore.',
  inspect: 'Show which cache a restore would pick. Download nothing.',
  prune: 'Delete old caches.',
};

export type FlagGroup = 'required' | 'storage' | 'cache' | 'transfer' | 'advanced';

/** The group of each input in the help of a command. tests/contract/cliHelp.test.ts checks it. */
export const FLAG_GROUPS: Record<FlagGroup, readonly string[]> = {
  required: ['bucket', 'key', 'path', 'preset'],
  storage: [
    'endpoint',
    'region',
    'provider',
    'access-key',
    'secret-key',
    'session-token',
    'force-path-style',
    'prefix',
    's3-key-pattern',
    'scoped-to-repository',
    'scoped-to-ref',
  ],
  cache: [
    'restore-keys',
    'fail-on-cache-miss',
    'lookup-only',
    'read-only',
    'enableCrossOsArchive',
    'metadata',
    'tags',
    'explain',
    'job-summary',
    'metrics-file',
    'max-candidates',
    'ref',
    'older-than-days',
    'keep-latest',
    'max-total-size',
    'abort-uploads-older-than-hours',
    'dry-run',
  ],
  transfer: [
    'upload-chunk-size',
    'upload-concurrency',
    'download-concurrency',
    'download-chunk-size',
    'transfer-tuning',
    'compression-level',
    'streaming',
    'retry',
    'retry-count',
  ],
  advanced: [
    'use-fallback',
    'dual-cache',
    'restore-priority',
    'dual-cache-strategy',
    'dual-cache-strict',
    'accessKey',
    'secretKey',
    'sessionToken',
  ],
};

const GROUP_TITLES: Record<FlagGroup, string> = {
  required: 'Required',
  storage: 'Storage',
  cache: 'Cache',
  transfer: 'Transfer',
  advanced: 'Advanced',
};

/**
 * Env vars that hold the context of the run. GenericHost does not read an input from them, so the
 * prune input `ref` reads only its flag. The same list is in src/ci/generic.ts.
 */
const CONTEXT_ENV_NAMES: ReadonlySet<string> = new Set([
  'CLOUD_CACHE_REF',
  'CLOUD_CACHE_REPOSITORY',
  'CLOUD_CACHE_BASE_REF',
  'CLOUD_CACHE_DEFAULT_BRANCH',
  'CLOUD_CACHE_WORKSPACE',
  'CLOUD_CACHE_EVENT_NAME',
]);

/**
 * The env vars that the storage client reads after the input, in order. Source:
 * createStorageContext in src/storage/client.ts. tests/contract/cliHelp.test.ts checks each one.
 */
export const FALLBACK_ENV: Readonly<Record<string, readonly string[]>> = {
  bucket: ['AWS_S3_BUCKET', 'S3_BUCKET'],
  endpoint: ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3'],
  region: ['AWS_REGION', 'AWS_DEFAULT_REGION'],
  'access-key': ['AWS_ACCESS_KEY_ID'],
  'secret-key': ['AWS_SECRET_ACCESS_KEY'],
  'session-token': ['AWS_SESSION_TOKEN'],
};

const GITHUB_ONLY =
  'GitHub Actions only: the CLI has no GitHub Actions cache service. Do not set it on the CLI.';

/**
 * A CLI note after the manifest description. The manifest text is written for a GitHub workflow,
 * so these notes tell what the flag does on the CLI. tests/contract/cliHelp.test.ts checks that
 * each key is an input.
 */
export const CLI_NOTES: Readonly<Record<string, string>> = {
  'use-fallback': GITHUB_ONLY,
  'dual-cache': GITHUB_ONLY,
  'dual-cache-strategy': GITHUB_ONLY,
  'dual-cache-strict': GITHUB_ONLY,
  'restore-priority': GITHUB_ONLY,
  'job-summary':
    'On the CLI: no effect on the generic platform. On bitbucket, the CLI prints a text summary.',
  'fail-on-cache-miss': 'On the CLI: exit with code 1 when no key matches.',
  'read-only':
    'On the CLI: save uploads nothing. A restore with this flag keeps it in the state file for save.',
  'scoped-to-repository': 'On the CLI, the repository comes from CLOUD_CACHE_REPOSITORY.',
  's3-key-pattern': 'On the CLI, ${GITHUB_REPOSITORY} is the value of CLOUD_CACHE_REPOSITORY.',
  enableCrossOsArchive: 'On the CLI, this applies to a Windows host.',
};

/** True when a manifest description gives the default value itself, for example "(default: 20)". */
export function descriptionGivesDefault(description: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\bdefault:? ${escaped}(?!\\w|\\.\\d)`, 'i').test(description);
}

/** The env var that an unset input flag reads, or undefined when the flag has none. */
export function inputEnvName(name: string): string | undefined {
  const envName = `CLOUD_CACHE_${name.toUpperCase().replace(/-/g, '_')}`;
  return CONTEXT_ENV_NAMES.has(envName) ? undefined : envName;
}

/** The column where the description starts. */
const COLUMN = 30;
/** The largest line length. */
const WIDTH = 100;

/** The indent of a word that is too long for the description column, such as a key pattern. */
const LONG_WORD_INDENT = '    ';

/**
 * Wraps a text to lines that start at COLUMN and end at WIDTH or before. A word that does not fit
 * in the column gets a line of its own with a smaller indent, so that the word stays whole.
 */
function wrap(text: string): string[] {
  const indent = ' '.repeat(COLUMN);
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line !== '') {
      lines.push(indent + line);
      line = '';
    }
  };
  for (const word of text.split(' ')) {
    if (COLUMN + word.length > WIDTH) {
      flush();
      lines.push(LONG_WORD_INDENT + word);
    } else if (line !== '' && COLUMN + line.length + 1 + word.length > WIDTH) {
      flush();
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  flush();
  return lines;
}

/** The lines of one flag: the flag form, then the wrapped description. */
function flagLines(form: string, text: string): string[] {
  const head = `  ${form}`;
  const body = wrap(text);
  const first = body[0];
  if (head.length < COLUMN - 1 && first?.startsWith(' '.repeat(COLUMN))) {
    return [`${head.padEnd(COLUMN)}${first.slice(COLUMN)}`, ...body.slice(1)];
  }
  return [head, ...body];
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The help text of one input flag of a command. */
export function inputFlagText(command: CliCommand, name: string): string {
  const description = FLAG_DESCRIPTIONS[command][name] ?? '';
  const parts = [sentence(description)];
  const note = CLI_NOTES[name];
  if (note !== undefined) {
    parts.push(note);
  }
  if (MULTILINE_INPUTS.has(name)) {
    parts.push('Repeatable.');
  }
  // Some descriptions give the default already, for example "(default: true)".
  const value = INPUT_DEFAULTS[command][name];
  if (value !== undefined && value !== '' && !descriptionGivesDefault(description, value)) {
    parts.push(`Default: ${value}.`);
  }
  const env = inputEnvName(name);
  const fallback = FALLBACK_ENV[name];
  if (env === undefined) {
    parts.push('Env: none.');
  } else {
    parts.push(`Env: ${env}${fallback ? `, then ${fallback.join(' or ')}` : ''}.`);
  }
  return parts.join(' ');
}

function inputFlagForm(name: string): string {
  return BOOLEAN_INPUTS.has(name) ? `--${name}[=true|false]` : `--${name} <value>`;
}

/** The CLI flags that every command takes, as [form, text]. */
function cliFlagEntries(command: CliCommand): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    [
      `--${CLI_FLAGS.stateFile} <path>`,
      'The state file that restore writes and save reads. ' +
        'Default: <tmpdir>/cloud-cache-state.json. Env: CLOUD_CACHE_STATE_FILE.',
    ],
    [
      `--${CLI_FLAGS.outputsFile} <path>`,
      'Append each output as name=value. A value with a newline uses the name<<delimiter form. ' +
        'Env: CLOUD_CACHE_OUTPUTS_FILE.',
    ],
    [`--${CLI_FLAGS.debug}`, 'Print debug messages. Env: CLOUD_CACHE_DEBUG.'],
    [
      `--${CLI_FLAGS.platform} <value>`,
      'auto, generic or bitbucket. Default: auto. It picks bitbucket when ' +
        'BITBUCKET_BUILD_NUMBER is set. Env: CLOUD_CACHE_PLATFORM.',
    ],
    [
      `--${CLI_FLAGS.allowRefOverride}[=true|false]`,
      'On bitbucket, use CLOUD_CACHE_REF, CLOUD_CACHE_BASE_REF and CLOUD_CACHE_REPOSITORY. ' +
        'Env: CLOUD_CACHE_ALLOW_REF_OVERRIDE.',
    ],
    [
      `--${CLI_FLAGS.roleArn} <arn>`,
      'The AWS role for the Bitbucket OIDC token. Env: CLOUD_CACHE_ROLE_ARN.',
    ],
  ];
  if (command === 'save') {
    entries.push([
      `--${CLI_FLAGS.saveOnFailure}[=true|false]`,
      'On bitbucket, save also when the step failed. Env: CLOUD_CACHE_SAVE_ON_FAILURE.',
    ]);
  }
  entries.push(['--help', 'Print this text.'], ['--version', 'Print the version.']);
  return entries;
}

function requiredTitle(command: CliCommand): string {
  return 'preset' in INPUT_DEFAULTS[command]
    ? 'Required (set --key and --path, or set --preset):'
    : 'Required:';
}

/** The help text of one command: its purpose and each of its flags, in groups. */
export function commandUsage(command: CliCommand): string {
  const inputs = INPUT_DEFAULTS[command];
  const lines = [
    `Usage: cloud-cache ${command} [flags]`,
    '',
    COMMAND_SUMMARIES[command],
    '',
    'The flags have the names of the action inputs. An unset flag reads its env var, then the',
    'default. A boolean flag without a value means true.',
  ];
  for (const group of Object.keys(FLAG_GROUPS) as FlagGroup[]) {
    const names = FLAG_GROUPS[group].filter((name) => name in inputs);
    if (names.length === 0) {
      continue;
    }
    lines.push('', group === 'required' ? requiredTitle(command) : `${GROUP_TITLES[group]}:`);
    for (const name of names) {
      lines.push(...flagLines(inputFlagForm(name), inputFlagText(command, name)));
    }
  }
  lines.push('', 'CLI:');
  for (const [form, text] of cliFlagEntries(command)) {
    lines.push(...flagLines(form, text));
  }
  lines.push(
    '',
    'fail-on-cache-miss' in inputs
      ? 'Exit codes: 0 success (a cache miss is a success without --fail-on-cache-miss), 1 failure,\n2 usage error.'
      : 'Exit codes: 0 success, 1 failure, 2 usage error.',
    'Run cloud-cache --help to see the commands and the env vars of the run context.',
    ''
  );
  return lines.join('\n');
}
