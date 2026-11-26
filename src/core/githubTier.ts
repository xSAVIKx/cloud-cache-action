import * as cache from '@actions/cache';
import { isExactKeyMatch } from '../utils/inputUtils';
import { GitHubCacheUnavailableError, gitHubCacheServiceProblem } from './cacheMode';
import { toError, type RestoreOutcome, type SaveOutcome } from './outcomes';

/**
 * The error for a run without the GitHub Actions cache service, or undefined when the service is
 * available. Without the service, @actions/cache retries each call for about 10 s and then fails.
 * A save also makes a second archive and leaves a temp directory. So each call checks first.
 */
function unavailable(): GitHubCacheUnavailableError | undefined {
  const problem = gitHubCacheServiceProblem();
  return problem === undefined ? undefined : new GitHubCacheUnavailableError(problem);
}

export async function restoreFromGitHub(
  paths: readonly string[],
  primaryKey: string,
  restoreKeys: readonly string[],
  lookupOnly: boolean,
  enableCrossOsArchive: boolean
): Promise<RestoreOutcome> {
  const error = unavailable();
  if (error) {
    return { kind: 'error', error };
  }
  try {
    const matchedKey = await cache.restoreCache(
      [...paths],
      primaryKey,
      [...restoreKeys],
      { lookupOnly },
      enableCrossOsArchive
    );
    if (!matchedKey) {
      return { kind: 'miss' };
    }
    return { kind: 'hit', matchedKey, exact: isExactKeyMatch(primaryKey, matchedKey) };
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}

/**
 * Whether GitHub Actions Cache already holds exactly `key`. A lookup also returns prefix
 * matches, which do not count. It throws a GitHubCacheUnavailableError when the service is not
 * available, so callers can apply strict mode. @actions/cache handles most other service failures
 * itself and reports a miss.
 */
export async function existsInGitHub(
  paths: readonly string[],
  key: string,
  enableCrossOsArchive: boolean
): Promise<boolean> {
  const error = unavailable();
  if (error) {
    throw error;
  }
  const matchedKey = await cache.restoreCache(
    [...paths],
    key,
    [],
    { lookupOnly: true },
    enableCrossOsArchive
  );
  return isExactKeyMatch(key, matchedKey);
}

export async function saveToGitHub(
  paths: readonly string[],
  key: string,
  uploadChunkSize: number | undefined,
  enableCrossOsArchive: boolean
): Promise<SaveOutcome> {
  const error = unavailable();
  if (error) {
    return { kind: 'error', error };
  }
  try {
    const cacheId = await cache.saveCache(
      [...paths],
      key,
      { uploadChunkSize },
      enableCrossOsArchive
    );
    // -1 means @actions/cache did not save and already logged why: another job is creating
    // the entry, the cache mode forbids writes, or it swallowed a service error itself.
    if (cacheId === -1) {
      return {
        kind: 'skipped',
        reason: 'GitHub Actions Cache did not save this key (see the messages above)',
      };
    }
    return { kind: 'saved' };
  } catch (err) {
    // @actions/cache throws a ValidationError when the path list is empty. It throws a plain
    // Error, with the same message prefix, when no path exists. Match the prefix for both.
    if (err instanceof Error && err.message.startsWith('Path Validation Error')) {
      return { kind: 'skipped', reason: 'no paths matched' };
    }
    return { kind: 'error', error: toError(err) };
  }
}
