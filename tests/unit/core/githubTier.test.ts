import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type RestoreCache = (
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: { lookupOnly?: boolean },
  enableCrossOsArchive?: boolean
) => Promise<string | undefined>;
type SaveCache = (
  paths: string[],
  key: string,
  options?: { uploadChunkSize?: number },
  enableCrossOsArchive?: boolean
) => Promise<number>;

const mockRestoreCache = jest.fn<RestoreCache>();
const mockSaveCache = jest.fn<SaveCache>();

jest.unstable_mockModule('@actions/cache', () => ({
  restoreCache: mockRestoreCache,
  saveCache: mockSaveCache,
}));

const { existsInGitHub, restoreFromGitHub, saveToGitHub } = await import(
  '../../../src/core/githubTier'
);
const { GitHubCacheUnavailableError } = await import('../../../src/core/cacheMode');

const SERVICE_ENV = [
  'ACTIONS_CACHE_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_SERVICE_V2',
  'GITHUB_SERVER_URL',
] as const;
const savedServiceEnv = Object.fromEntries(SERVICE_ENV.map((name) => [name, process.env[name]]));

/** Sets the service variables of a run, and removes the others. */
function setServiceEnv(env: Partial<Record<(typeof SERVICE_ENV)[number], string>>): void {
  for (const name of SERVICE_ENV) {
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
}

// The env of a JavaScript action on github.com with cache service v2.
const GITHUB_COM_V2 = {
  ACTIONS_RESULTS_URL: 'https://results.example/',
  ACTIONS_CACHE_SERVICE_V2: 'true',
};

beforeEach(() => {
  mockRestoreCache.mockReset();
  mockSaveCache.mockReset();
  setServiceEnv(GITHUB_COM_V2);
});
afterAll(() => {
  setServiceEnv(savedServiceEnv);
});

describe('restoreFromGitHub', () => {
  it('reports an exact hit and passes every option through', async () => {
    mockRestoreCache.mockResolvedValue('Linux-npm-abc');
    await expect(
      restoreFromGitHub(['~/.npm'], 'Linux-npm-abc', ['Linux-npm-'], false, true)
    ).resolves.toEqual({ kind: 'hit', matchedKey: 'Linux-npm-abc', exact: true });
    expect(mockRestoreCache).toHaveBeenCalledWith(
      ['~/.npm'],
      'Linux-npm-abc',
      ['Linux-npm-'],
      { lookupOnly: false },
      true
    );
  });

  it('reports a restore-key match as a partial hit', async () => {
    mockRestoreCache.mockResolvedValue('Linux-npm-old');
    await expect(
      restoreFromGitHub(['a'], 'Linux-npm-abc', ['Linux-npm-'], true, false)
    ).resolves.toEqual({
      kind: 'hit',
      matchedKey: 'Linux-npm-old',
      exact: false,
    });
  });

  it('reports a miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    await expect(restoreFromGitHub(['a'], 'k', [], false, false)).resolves.toEqual({
      kind: 'miss',
    });
  });

  it('returns failures instead of throwing', async () => {
    const error = new Error('Cache service responded with 503');
    mockRestoreCache.mockRejectedValue(error);
    await expect(restoreFromGitHub(['a'], 'k', [], false, false)).resolves.toEqual({
      kind: 'error',
      error,
    });
  });
});

describe('existsInGitHub', () => {
  it('is true only for an exact key, using a lookup-only restore', async () => {
    mockRestoreCache.mockResolvedValue('k');
    await expect(existsInGitHub(['a'], 'k', true)).resolves.toBe(true);
    expect(mockRestoreCache).toHaveBeenCalledWith(['a'], 'k', [], { lookupOnly: true }, true);
  });

  it('does not count a prefix match as already present', async () => {
    mockRestoreCache.mockResolvedValue('k-older');
    await expect(existsInGitHub(['a'], 'k', false)).resolves.toBe(false);
  });

  it('is false on a miss', async () => {
    mockRestoreCache.mockResolvedValue(undefined);
    await expect(existsInGitHub(['a'], 'k', false)).resolves.toBe(false);
  });

  it('lets service failures propagate', async () => {
    mockRestoreCache.mockRejectedValue(new Error('unavailable'));
    await expect(existsInGitHub(['a'], 'k', false)).rejects.toThrow('unavailable');
  });
});

describe('saveToGitHub', () => {
  it('reports a saved cache and passes the chunk size through', async () => {
    mockSaveCache.mockResolvedValue(42);
    await expect(saveToGitHub(['a'], 'k', 1024, true)).resolves.toEqual({ kind: 'saved' });
    expect(mockSaveCache).toHaveBeenCalledWith(['a'], 'k', { uploadChunkSize: 1024 }, true);
  });

  it('treats the -1 cache id as skipped, because @actions/cache already logged why', async () => {
    mockSaveCache.mockResolvedValue(-1);
    await expect(saveToGitHub(['a'], 'k', undefined, false)).resolves.toEqual({
      kind: 'skipped',
      reason: 'GitHub Actions Cache did not save this key (see the messages above)',
    });
  });

  it('returns thrown failures', async () => {
    mockSaveCache.mockRejectedValue('quota exceeded');
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('quota exceeded');
  });

  it('treats a path validation error as skipped, consistent with the S3 tier', async () => {
    const error = new Error(
      'Path Validation Error: At least one directory or file path is required'
    );
    error.name = 'ValidationError';
    mockSaveCache.mockRejectedValue(error);
    await expect(saveToGitHub(['a'], 'k', undefined, false)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no paths matched',
    });
  });

  it('treats the plain error @actions/cache throws when no path exists as skipped', async () => {
    // saveCache throws a plain Error here, not a ValidationError, so the name is "Error".
    mockSaveCache.mockRejectedValue(
      new Error(
        'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.'
      )
    );
    await expect(saveToGitHub(['missing/**'], 'k', undefined, false)).resolves.toEqual({
      kind: 'skipped',
      reason: 'no paths matched',
    });
  });

  it('still reports another validation error as an error', async () => {
    const error = new Error('Key Validation Error: k cannot contain commas.');
    error.name = 'ValidationError';
    mockSaveCache.mockRejectedValue(error);
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome).toEqual({ kind: 'error', error });
  });
});

describe('without the GitHub Actions cache service', () => {
  const NO_SERVICE = /^GitHub Actions Cache is not available: ACTIONS_CACHE_URL is not set/;

  beforeEach(() => {
    setServiceEnv({});
  });

  it('restore returns the error at once and does not call @actions/cache', async () => {
    const outcome = await restoreFromGitHub(['a'], 'k', [], false, false);
    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' && outcome.error.message).toMatch(NO_SERVICE);
    expect(outcome.kind === 'error' && outcome.error).toBeInstanceOf(GitHubCacheUnavailableError);
    expect(mockRestoreCache).not.toHaveBeenCalled();
  });

  it('the existence check throws at once', async () => {
    await expect(existsInGitHub(['a'], 'k', false)).rejects.toThrow(GitHubCacheUnavailableError);
    expect(mockRestoreCache).not.toHaveBeenCalled();
  });

  it('save returns the error at once and makes no archive', async () => {
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome.kind === 'error' && outcome.error.message).toMatch(NO_SERVICE);
    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  it('cache service v2 needs ACTIONS_RESULTS_URL', async () => {
    setServiceEnv({ ACTIONS_CACHE_SERVICE_V2: 'true', ACTIONS_CACHE_URL: 'https://cache/' });
    const outcome = await saveToGitHub(['a'], 'k', undefined, false);
    expect(outcome.kind === 'error' && outcome.error.message).toContain(
      'ACTIONS_RESULTS_URL is not set (cache service v2)'
    );
    expect(mockSaveCache).not.toHaveBeenCalled();
  });

  it('cache service v1 needs ACTIONS_CACHE_URL, also when ACTIONS_RESULTS_URL is set', async () => {
    setServiceEnv({ ACTIONS_RESULTS_URL: 'https://results/' });
    await expect(existsInGitHub(['a'], 'k', false)).rejects.toThrow(
      'ACTIONS_CACHE_URL is not set (cache service v1)'
    );
  });

  it('GHES always uses v1, so it needs ACTIONS_CACHE_URL', async () => {
    setServiceEnv({ ...GITHUB_COM_V2, GITHUB_SERVER_URL: 'https://ghes.example.com' });
    await expect(existsInGitHub(['a'], 'k', false)).rejects.toThrow(
      'ACTIONS_CACHE_URL is not set (cache service v1)'
    );
  });
});

describe('with the GitHub Actions cache service, as in the action on a runner', () => {
  it.each([
    ['github.com, cache service v2', GITHUB_COM_V2],
    ['github.com, cache service v1', { ACTIONS_CACHE_URL: 'https://cache/' }],
    ['GHE.com, cache service v2', { ...GITHUB_COM_V2, GITHUB_SERVER_URL: 'https://octo.ghe.com' }],
    [
      'GHES, cache service v1',
      {
        ACTIONS_CACHE_URL: 'https://cache/',
        ACTIONS_CACHE_SERVICE_V2: 'true',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      },
    ],
  ])('%s calls @actions/cache', async (_name, env) => {
    setServiceEnv(env);
    mockRestoreCache.mockResolvedValue('k');
    mockSaveCache.mockResolvedValue(1);
    await expect(restoreFromGitHub(['a'], 'k', [], false, false)).resolves.toMatchObject({
      kind: 'hit',
    });
    await expect(existsInGitHub(['a'], 'k', false)).resolves.toBe(true);
    await expect(saveToGitHub(['a'], 'k', undefined, false)).resolves.toEqual({ kind: 'saved' });
    expect(mockRestoreCache).toHaveBeenCalledTimes(2);
    expect(mockSaveCache).toHaveBeenCalledTimes(1);
  });
});
