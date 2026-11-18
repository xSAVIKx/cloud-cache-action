import type { CiLogger } from '../ci/host';

/**
 * Some engine messages name an action input in the words of a workflow file, for example
 * `Input "upload-chunk-size"` or `Set read-only: true`. The CLI user sets a flag, not an input, so
 * the CLI prints the flag form. The action keeps its own messages: only the CLI calls this.
 */
const REWRITES: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [
    /Bucket name is required\. Please set "bucket" input or AWS_S3_BUCKET environment variable\./g,
    'The bucket name is required. Set --bucket, CLOUD_CACHE_BUCKET, AWS_S3_BUCKET or S3_BUCKET.',
  ],
  [
    /Key is not specified\. Set key and path, or set preset\./g,
    'Key is not specified. Set --key and --path, or set --preset, or run restore with the same ' +
      '--state-file first.',
  ],
  [/Input required and not supplied: ([A-Za-z-]+)/g, 'The flag --$1 is required and not set'],
  [/Set key and path, or set preset\./g, 'Set --key and --path, or set --preset.'],
  [/Set read-only: true to skip the save\./g, 'Set --read-only to skip the save.'],
  [/Input "([A-Za-z-]+)"/g, '--$1'],
  [/The "([A-Za-z-]+)" input/g, 'The --$1 value'],
  [/"(metadata|tags)" (line|key|value|sets|allows)\b/g, '--$1 $2'],
];

/** The message with the CLI flag names in place of the action input names. */
export function toCliWords(message: string): string {
  let text = message;
  for (const [pattern, replacement] of REWRITES) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Makes the warnings and the errors of a CLI host logger use the CLI words. The logger object is
 * changed in place, so that `setFailed`, which calls `log.error`, also uses them.
 */
export function useCliWords(log: CiLogger): void {
  const { warning, error } = log;
  log.warning = (message) => warning(toCliWords(message));
  log.error = (message) => error(toCliWords(message));
}
