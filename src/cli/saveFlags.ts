import { getHost } from '../ci/host';
import type { FileStateProvider } from '../ci/stateFile';
import { State } from '../constants';
import { parseMetadata, parseTags } from '../core/objectAttributes';

/** True when the flag value gives the same setting as the value in the state file. */
type Same = (flag: string, persisted: string) => boolean;

const sameText: Same = (flag, persisted) => flag.trim() === persisted;
const sameNumber: Same = (flag, persisted) => Number(flag.trim()) === Number(persisted);
const sameJson =
  (parse: (raw: string) => unknown): Same =>
  (flag, persisted) => {
    try {
      return JSON.stringify(parse(flag)) === persisted;
    } catch {
      // The save reads the flag again and reports the error.
      return false;
    }
  };

/**
 * The save flags that restore keeps in the state file. The key and the paths are not here: the
 * state wins for them, and warnOnStateMismatch in main.ts warns.
 */
const PERSISTED_FLAGS: ReadonlyArray<readonly [flag: string, key: State, same: Same]> = [
  ['read-only', State.CacheReadOnly, sameText],
  ['s3-key-pattern', State.CacheS3KeyPattern, sameText],
  ['prefix', State.CachePrefix, sameText],
  ['scoped-to-repository', State.CacheScopedToRepository, sameText],
  ['scoped-to-ref', State.CacheScopedToRef, sameText],
  ['retry', State.CacheRetry, sameText],
  ['retry-count', State.CacheRetryCount, sameNumber],
  ['dual-cache', State.CacheDualCache, sameText],
  ['dual-cache-strategy', State.CacheDualCacheStrategy, sameText],
  ['dual-cache-strict', State.CacheDualCacheStrict, sameText],
  ['streaming', State.CacheStreaming, sameText],
  ['job-summary', State.CacheJobSummary, sameText],
  ['metadata', State.CacheMetadata, sameJson(parseMetadata)],
  ['tags', State.CacheTags, sameJson(parseTags)],
  ['metrics-file', State.CacheMetricsFile, sameText],
  ['transfer-tuning', State.CacheTransferTuning, sameText],
];

/** The flags that change the S3 object key. */
const OBJECT_KEY_FLAGS: ReadonlySet<string> = new Set([
  's3-key-pattern',
  'prefix',
  'scoped-to-repository',
  'scoped-to-ref',
]);

/**
 * Lets a flag on the save command line win over the value that restore kept in the state file.
 * It clears that value for this process only, so save reads the flag. The file does not change,
 * so a later save reads the state of restore again. A value that no flag gives still comes from
 * the state. When a flag changes the S3 object key, the exact hit of restore was for another
 * object, so it clears that hit too. It prints one warning that names the flags that won.
 */
export function applySaveFlags(
  state: Pick<FileStateProvider, 'getState' | 'override'>,
  flags: Record<string, string>,
  stateFile: string
): void {
  // Without a restore, the state is empty and every setting comes from the flags already.
  if (state.getState(State.CachePrimaryKey) === '') {
    return;
  }
  const won: string[] = [];
  for (const [flag, key, same] of PERSISTED_FLAGS) {
    const value = flags[flag];
    // Restore writes every setting, also an empty one such as the default prefix. So an empty
    // value is a value to compare, not a missing one.
    if (value === undefined || same(value, state.getState(key))) {
      continue;
    }
    state.override(key, '');
    if (OBJECT_KEY_FLAGS.has(flag)) {
      state.override(State.CacheS3ExactHit, '');
    }
    won.push(`--${flag}`);
  }
  if (won.length > 0) {
    getHost().log.warning(
      `The flags ${won.join(', ')} differ from the values in the state file ${stateFile}. ` +
        'The flags win. The other values come from the state.'
    );
  }
}
