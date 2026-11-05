import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { compileKeyTemplate, type KeyTemplate } from '../../../src/core/keyTemplate';
import type { StorageContext } from '../../../src/storage/client';

const mockInfo = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();
jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  warning: mockWarning,
  debug: jest.fn(),
}));
const { pruneCaches } = await import('../../../src/core/prune');

const s3Mock = mockClient(S3Client);

const NOW = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

const FEATURE = 'refs/heads/feature';
const MAIN = 'refs/heads/main';

const storage: StorageContext = {
  client: new S3Client({ region: 'us-east-1' }),
  bucket: 'bucket',
  providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
};

function templateFor(
  overrides: Partial<Parameters<typeof compileKeyTemplate>[0]> = {}
): KeyTemplate {
  return compileKeyTemplate({
    pattern: '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}',
    repository: 'octo/app',
    prefix: '',
    scopedToRepository: true,
    scopedToRef: true,
    version: 'v1',
    archiveFilename: 'cache.tar.zst',
    env: {},
    ...overrides,
  });
}

function object(
  key: string,
  size: number,
  lastModified?: Date
): { Key: string; Size: number; LastModified?: Date } {
  return { Key: key, Size: size, LastModified: lastModified };
}

beforeEach(() => {
  s3Mock.reset();
  mockInfo.mockClear();
  mockWarning.mockClear();
});

describe('pruneCaches', () => {
  it('prunes only objects past the age cutoff and reports what it kept', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 100, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 200, daysAgo(1)),
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 5, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result).toEqual({
      pruned: [
        {
          key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
          size: 100,
          lastModified: daysAgo(10),
        },
      ],
      keptCount: 1,
      prunedBytes: 100,
      abortedUploads: 0,
      dryRun: false,
    });
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'bucket',
      Key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
    });
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input).toMatchObject({
      Bucket: 'bucket',
      Prefix: 'octo/app/refs%2Fheads%2Fmain/',
    });
  });

  it('lists only the given ref by default, and every ref when none is given', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Ffeature/k1/v1/cache.tar.zst', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 20, daysAgo(10)),
      ],
      IsTruncated: false,
    });

    const scoped = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: FEATURE, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command).at(-1)?.args[0].input.Prefix).toBe(
      'octo/app/refs%2Fheads%2Ffeature/'
    );
    // The fake ignores Prefix; the key matcher still keeps the other ref out.
    expect(scoped.pruned.map((p) => p.key)).toEqual([
      'octo/app/refs%2Fheads%2Ffeature/k1/v1/cache.tar.zst',
    ]);

    const all = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command).at(-1)?.args[0].input.Prefix).toBe(
      'octo/app/'
    );
    expect(all.pruned).toHaveLength(2);
  });

  it('only considers archive objects, leaving unrelated objects untouched', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/notes.txt', 10, daysAgo(10)),
        object('octo/app/refs%2Fheads%2Fmain/k3/v1/cache.tar.zst.tmp', 10, daysAgo(10)),
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result.pruned.map((p) => p.key).sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz',
    ]);
    const deletedKeys = s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((call) => call.args[0].input.Key);
    expect(deletedKeys.sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.gz',
    ]);
  });

  it('escapes control characters in a listed key before it goes to the log', async () => {
    const evil = 'octo/app/refs%2Fheads%2Fmain/k\n::error title=injected::x/v1/cache.tar.zst';
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [object(evil, 100, daysAgo(10))],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    await pruneCaches(
      { storage, template: templateFor() },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    const lines = mockInfo.mock.calls.map(([message]) => message);
    expect(lines.filter((line) => line.includes('\n'))).toEqual([]);
    expect(lines.some((line) => line.startsWith('Pruned ') && line.includes('k\\n::error'))).toBe(
      true
    );
  });

  it('deletes nothing on a dry run', async () => {
    const template = templateFor();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 100, daysAgo(10))],
      IsTruncated: false,
    });

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: true, now: NOW }
    );

    expect(result.dryRun).toBe(true);
    expect(result.pruned).toEqual([
      {
        key: 'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
        size: 100,
        lastModified: daysAgo(10),
      },
    ]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  it.each([
    ['${key}/${archive_filename}', false],
    ['${ref}/${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', true],
  ])('refuses to prune when %s leaves no fixed listing prefix', async (pattern, scoped) => {
    const template = compileKeyTemplate({
      pattern,
      repository: 'octo/app',
      prefix: '',
      scopedToRepository: scoped,
      scopedToRef: scoped,
      version: 'v1',
      archiveFilename: 'cache.tar.zst',
      env: {},
    });

    await expect(
      pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: true, now: NOW })
    ).rejects.toThrow(
      'Refusing to prune: s3-key-pattern leaves no fixed prefix to list under, which would scan the whole bucket. Set "prefix", keep "scoped-to-repository" enabled, or set "ref" when the pattern starts with ${ref}.'
    );
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });

  it('follows continuation tokens across pages', async () => {
    const template = templateFor();
    const pages: Record<string, object> = {
      start: {
        Contents: [object('octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst', 10, daysAgo(10))],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      t1: {
        Contents: [object('octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst', 20, daysAgo(10))],
        IsTruncated: false,
      },
    };
    s3Mock
      .on(ListObjectsV2Command)
      .callsFake(
        (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
      );

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: true, now: NOW }
    );

    expect(result.pruned.map((p) => p.key).sort()).toEqual([
      'octo/app/refs%2Fheads%2Fmain/k1/v1/cache.tar.zst',
      'octo/app/refs%2Fheads%2Fmain/k2/v1/cache.tar.zst',
    ]);
    const calls = s3Mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
    expect(calls.map((input) => input.ContinuationToken)).toEqual([undefined, 't1']);
  });

  it('attempts every deletion and throws an aggregate error listing up to 5 failed keys', async () => {
    const template = templateFor();
    const keys = Array.from(
      { length: 7 },
      (_, i) => `octo/app/refs%2Fheads%2Fmain/k${i}/v1/cache.tar.zst`
    );
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, daysAgo(10))),
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).callsFake((input: { Key: string }) => {
      throw new Error(`boom: ${input.Key}`);
    });

    const promise = pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );
    await expect(promise).rejects.toThrow('Failed to delete 7 cache object(s):');
    await expect(promise).rejects.toThrow('and 2 more');
    await expect(promise).rejects.toBeInstanceOf(AggregateError);
    // Every candidate was attempted even though all of them failed.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(7);
  });

  it('respects the concurrency cap while deleting', async () => {
    const template = templateFor();
    const keys = Array.from(
      { length: 6 },
      (_, i) => `octo/app/refs%2Fheads%2Fmain/k${i}/v1/cache.tar.zst`
    );
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, daysAgo(10))),
      IsTruncated: false,
    });
    let active = 0;
    let maxActive = 0;
    s3Mock.on(DeleteObjectCommand).callsFake(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return {};
    });

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW, concurrency: 2 }
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(6);
  });
});

describe('pruneCaches key matching', () => {
  const REPO = 'acme/app';
  const OLD = daysAgo(30);

  function templateWith(
    pattern: string,
    overrides: Partial<Parameters<typeof compileKeyTemplate>[0]> = {}
  ): KeyTemplate {
    // Compiled the way buildPruneTier compiles it: no version, the zstd archive filename.
    return compileKeyTemplate({
      pattern,
      repository: REPO,
      prefix: '',
      scopedToRepository: true,
      scopedToRef: true,
      version: '',
      archiveFilename: 'cache.tar.zst',
      env: {},
      ...overrides,
    });
  }

  function listing(keys: string[]): void {
    // The fake ignores Prefix, so every key below reaches the matcher.
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => object(key, 10, OLD)),
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
  }

  function deletedKeys(): string[] {
    return s3Mock
      .commandCalls(DeleteObjectCommand)
      .map((call) => call.args[0].input.Key as string)
      .sort();
  }

  it('A: keeps another repository whose name extends this one when ${ref} is glued to the repository', async () => {
    const template = templateWith(
      'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'builds/acme/app-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const ownOtherRef = 'builds/acme/app-refs%2Fheads%2Frelease/k/27747e0d22df7792/cache.tar.gz';
    const foreign = 'builds/acme/app-legacy-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, ownOtherRef, foreign]);

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: false, now: NOW }
    );

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(
      'builds/acme/app-'
    );
    expect(deletedKeys()).toEqual([own, ownOtherRef].sort());
    expect(result.pruned.map((p) => p.key).sort()).toEqual([own, ownOtherRef].sort());
    expect(result.keptCount).toBe(0);
  });

  it('B: keeps other refs of the same repository when pruning one ref', async () => {
    const template = templateWith('${GITHUB_REPOSITORY}/${key}/${ref}/${archive_filename}');
    const own = 'acme/app/k/refs%2Fheads%2Fmain/cache.tar.zst';
    const ownSlashedKey = 'acme/app/Linux/npm/refs%2Fheads%2Fmain/cache.tar.gz';
    const otherRef = 'acme/app/k/refs%2Fheads%2Frelease/cache.tar.zst';
    listing([own, ownSlashedKey, otherRef]);

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(deletedKeys()).toEqual([own, ownSlashedKey].sort());
  });

  it('C: keeps another repository when ${key} precedes ${GITHUB_REPOSITORY}', async () => {
    const template = templateWith('shared/${key}/${GITHUB_REPOSITORY}/${archive_filename}');
    const own = 'shared/k/acme/app/cache.tar.zst';
    const foreign = 'shared/k/other/repo/cache.tar.zst';
    const foreignKeyNamedLikeUs = 'shared/acme/app/other/repo/cache.tar.zst';
    const foreignLongerName = 'shared/k/acme/app-legacy/cache.tar.zst';
    listing([own, foreign, foreignKeyNamedLikeUs, foreignLongerName]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(deletedKeys()).toEqual([own]);
  });

  it('D: the default pattern with one ref deletes only that ref of this repository', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const otherRef = 'acme/app/refs%2Fheads%2Ffeature/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'acme/app-legacy/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, otherRef, foreign]);

    await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(
      'acme/app/refs%2Fheads%2Fmain/'
    );
    expect(deletedKeys()).toEqual([own]);
  });

  it('D: the default pattern for every ref keeps another prefix and another repository', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const main = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const feature = 'acme/app/refs%2Fheads%2Ffeature/Linux/k/27747e0d22df7792/cache.tar.gz';
    const otherPrefix = 'acme/app/web/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'acme/app-legacy/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([main, feature, otherPrefix, foreign]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(deletedKeys()).toEqual([feature, main].sort());
  });

  it('never deletes a non-archive object or a key that does not fill the whole pattern', async () => {
    const template = templateWith(
      '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([
      own,
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/notes.txt',
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst.tmp',
      'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/my-cache.tar.zst',
      'acme/app/refs%2Fheads%2Fmain/cache.tar.zst',
      'acme/app/refs%2Fheads%2Fmain/k/cache.tar.zst',
    ]);

    const result = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(deletedKeys()).toEqual([own]);
    expect(result.keptCount).toBe(0);
  });

  it('reports the same candidates on a dry run as a real run deletes', async () => {
    const template = templateWith(
      'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
    );
    const own = 'builds/acme/app-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'builds/acme/app-legacy-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
    listing([own, foreign]);

    const dry = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: true, now: NOW }
    );
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    const real = await pruneCaches(
      { storage, template },
      { olderThanDays: 1, dryRun: false, now: NOW }
    );

    expect(dry.pruned.map((p) => p.key)).toEqual([own]);
    expect(real.pruned.map((p) => p.key)).toEqual(dry.pruned.map((p) => p.key));
    expect(deletedKeys()).toEqual([own]);
  });

  it('keeps other repositories when an all-refs pattern places ${ref} before the repository', async () => {
    const template = templateWith(
      'shared/${ref}/${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}'
    );
    const own = 'shared/refs%2Fheads%2Fmain/acme/app/k/27747e0d22df7792/cache.tar.zst';
    const foreign = 'shared/refs%2Fheads%2Fmain/other/repo/k/27747e0d22df7792/cache.tar.zst';
    const foreignKeyNamedLikeUs =
      'shared/refs%2Fheads%2Fmain/other/repo/acme/app/27747e0d22df7792/cache.tar.zst';
    listing([own, foreign, foreignKeyNamedLikeUs]);

    await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe('shared/');
    expect(deletedKeys()).toEqual([own]);
  });

  describe('with scoped-to-ref false', () => {
    const DEFAULT = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';

    it("deletes this repository's unscoped caches and keeps ref-scoped and foreign ones", async () => {
      const template = templateWith(DEFAULT, { scopedToRef: false });
      const own = 'acme/app/k/27747e0d22df7792/cache.tar.zst';
      const ownSlashedKey = 'acme/app/Linux/npm/27747e0d22df7792/cache.tar.gz';
      const refScoped = 'acme/app/refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
      const foreign = 'acme/app-legacy/k/27747e0d22df7792/cache.tar.zst';
      const notArchive = 'acme/app/k/27747e0d22df7792/notes.txt';
      listing([own, ownSlashedKey, refScoped, foreign, notArchive]);

      const result = await pruneCaches(
        { storage, template },
        { olderThanDays: 1, dryRun: false, now: NOW }
      );

      expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe('acme/app/');
      expect(deletedKeys()).toEqual([own, ownSlashedKey].sort());
      expect(result.pruned.map((p) => p.key).sort()).toEqual([own, ownSlashedKey].sort());
    });

    it("resolves a glued ${ref} with the key builder's removal rules", async () => {
      const template = templateWith(
        'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}',
        { scopedToRef: false }
      );
      const own = 'builds/acme/app-/k/27747e0d22df7792/cache.tar.zst';
      const refScoped = 'builds/acme/app-refs%2Fheads%2Fmain/k/27747e0d22df7792/cache.tar.zst';
      const foreign = 'builds/acme/app-legacy-/k/27747e0d22df7792/cache.tar.zst';
      listing([own, refScoped, foreign]);

      await pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW });

      expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe(
        'builds/acme/app-/'
      );
      expect(deletedKeys()).toEqual([own]);
    });
  });

  describe('refusals', () => {
    const repositoryMessage =
      'Refusing to prune: s3-key-pattern puts ${GITHUB_REPOSITORY} in a path segment with ${key}, ${version} or a preceding ${ref}, so other repositories\' caches could match. Separate ${GITHUB_REPOSITORY} from them with "/".';

    it.each([
      ['cache/${key}-${GITHUB_REPOSITORY}/${version}/${archive_filename}', undefined],
      ['cache/${GITHUB_REPOSITORY}${key}/${version}/${archive_filename}', undefined],
      ['cache/${GITHUB_REPOSITORY}-${version}/${key}/${archive_filename}', undefined],
      ['builds/${ref}-${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', undefined],
      ['builds/${ref}-${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}', MAIN],
    ])('refuses %s (ref %s) when repositories cannot be told apart', async (pattern, ref) => {
      const template = templateWith(pattern);
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref, dryRun: false, now: NOW })
      ).rejects.toThrow(repositoryMessage);
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses to prune one ref when ${ref} shares a segment with ${key}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${key}-${ref}/${archive_filename}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune ref "refs/heads/main": s3-key-pattern puts ${ref} in a path segment with ${key}, ${version} or another ${ref}, so other refs\' caches could match. Separate ${ref} from them with "/", or leave "ref" empty to prune every ref.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses a pattern with no ${archive_filename}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${ref}/${key}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune: s3-key-pattern has no ${archive_filename}, so cache archives cannot be told apart from other objects.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('refuses to prune one ref when the pattern has no ${ref}', async () => {
      const template = templateWith('${GITHUB_REPOSITORY}/${key}/${archive_filename}');
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).rejects.toThrow(
        'Refusing to prune ref "refs/heads/main": s3-key-pattern has no ${ref}, so every ref shares the same object keys. Leave "ref" empty to prune them all.'
      );
      expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    });

    it('allows the repository glued before ${ref}, which ref encoding keeps unambiguous', async () => {
      const template = templateWith(
        'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}'
      );
      listing([]);
      await expect(
        pruneCaches({ storage, template }, { olderThanDays: 1, ref: MAIN, dryRun: false, now: NOW })
      ).resolves.toMatchObject({ pruned: [] });
    });
  });
});

describe('pruneCaches count and size rules', () => {
  const FEATURE_KEY = (name: string): string =>
    `octo/app/refs%2Fheads%2Ffeature/${name}/v1/cache.tar.zst`;
  const MAIN_KEY = (name: string): string =>
    `octo/app/refs%2Fheads%2Fmain/${name}/v1/cache.tar.zst`;
  const deleted = (): string[] =>
    s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key as string);

  beforeEach(() => {
    s3Mock.on(DeleteObjectCommand).resolves({});
  });

  it('keeps the newest N of each ref and deletes the rest with keep-latest alone', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object(MAIN_KEY('a'), 10, daysAgo(1)),
        object(MAIN_KEY('b'), 10, daysAgo(2)),
        object(MAIN_KEY('c'), 10, daysAgo(3)),
        object(FEATURE_KEY('a'), 10, daysAgo(50)),
      ],
      IsTruncated: false,
    });
    const result = await pruneCaches(
      { storage, template: templateFor() },
      { keepLatest: 2, dryRun: false, now: NOW }
    );
    expect(deleted()).toEqual([MAIN_KEY('c')]);
    expect(result.keptCount).toBe(3);
    expect(result.prunedBytes).toBe(10);
  });

  it('deletes an archive only when it is older than the limit and not among the newest N', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object(MAIN_KEY('new'), 10, daysAgo(1)),
        object(MAIN_KEY('old1'), 10, daysAgo(40)),
        object(MAIN_KEY('old2'), 10, daysAgo(50)),
        object(FEATURE_KEY('only'), 10, daysAgo(90)),
      ],
      IsTruncated: false,
    });
    await pruneCaches(
      { storage, template: templateFor() },
      { olderThanDays: 30, keepLatest: 1, dryRun: false, now: NOW }
    );
    expect(deleted().sort()).toEqual([MAIN_KEY('old1'), MAIN_KEY('old2')]);
  });

  it('treats the whole scope as one group when the key pattern has no ref', async () => {
    const template = templateFor({
      pattern: '${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}',
    });
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object('octo/app/k1/v1/cache.tar.zst', 10, daysAgo(1)),
        object('octo/app/k2/v1/cache.tar.zst', 10, daysAgo(2)),
        object('octo/app/k3/v1/cache.tar.zst', 10, daysAgo(3)),
      ],
      IsTruncated: false,
    });
    await pruneCaches({ storage, template }, { keepLatest: 2, dryRun: false, now: NOW });
    expect(deleted()).toEqual(['octo/app/k3/v1/cache.tar.zst']);
  });

  it('applies the size budget to every ref in scope and logs each reason', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        object(MAIN_KEY('a'), 100, daysAgo(1)),
        object(MAIN_KEY('b'), 100, daysAgo(60)),
        object(FEATURE_KEY('a'), 100, daysAgo(20)),
        object(FEATURE_KEY('b'), 100, daysAgo(5)),
      ],
      IsTruncated: false,
    });
    const result = await pruneCaches(
      { storage, template: templateFor() },
      { olderThanDays: 30, maxTotalSize: 200, dryRun: true, now: NOW }
    );
    expect(result.pruned.map((p) => p.key)).toEqual([MAIN_KEY('b'), FEATURE_KEY('a')]);
    expect(result.prunedBytes).toBe(200);
    expect(result.keptCount).toBe(2);
    const lines = mockInfo.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(`Would prune ${MAIN_KEY('b')} (100.00 B, 60d old, age)`);
    expect(lines).toContain(`Would prune ${FEATURE_KEY('a')} (100.00 B, 20d old, size budget)`);
    expect(lines.at(-1)).toBe(
      'Would prune 2 cache object(s) totaling 200.00 B (1 by age, 1 by size budget).'
    );
    expect(deleted()).toEqual([]);
  });

  it('warns when keep-latest archives keep the total over the budget', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [object(MAIN_KEY('a'), 100, daysAgo(1))],
      IsTruncated: false,
    });
    await pruneCaches(
      { storage, template: templateFor() },
      { keepLatest: 1, maxTotalSize: 40, dryRun: true, now: NOW }
    );
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('60.00 B over "max-total-size"')
    );
  });

  it('refuses to run with no rule', async () => {
    await expect(
      pruneCaches({ storage, template: templateFor() }, { dryRun: true, now: NOW })
    ).rejects.toThrow('Set at least one of');
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });
});

describe('pruneCaches stale multipart uploads', () => {
  const MAIN_KEY = (name: string): string =>
    `octo/app/refs%2Fheads%2Fmain/${name}/v1/cache.tar.zst`;
  const hoursAgo = (n: number): Date => new Date(NOW.getTime() - n * 60 * 60 * 1000);
  const upload = (
    key: string,
    initiated: Date | undefined,
    id = `id-${key}`
  ): { Key: string; UploadId: string; Initiated?: Date } => ({
    Key: key,
    UploadId: id,
    Initiated: initiated,
  });
  const aborted = (): Array<{ Key?: string; UploadId?: string }> =>
    s3Mock.commandCalls(AbortMultipartUploadCommand).map((call) => call.args[0].input);

  beforeEach(() => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
  });

  it('aborts only the uploads older than the limit, under the scope prefix', async () => {
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        upload(MAIN_KEY('old'), hoursAgo(30)),
        upload(MAIN_KEY('new'), hoursAgo(2)),
        upload(MAIN_KEY('nodate'), undefined),
        // Not a cache archive key: prune must not touch it.
        upload('octo/app/refs%2Fheads%2Fmain/k/v1/notes.txt', hoursAgo(99)),
      ],
      IsTruncated: false,
    });

    const result = await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(aborted()).toEqual([
      { Bucket: 'bucket', Key: MAIN_KEY('old'), UploadId: `id-${MAIN_KEY('old')}` },
    ]);
    expect(result.abortedUploads).toBe(1);
    expect(result.pruned).toEqual([]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(ListMultipartUploadsCommand)[0].args[0].input).toMatchObject({
      Bucket: 'bucket',
      Prefix: 'octo/app/refs%2Fheads%2Fmain/',
    });
    expect(mockInfo).toHaveBeenCalledWith(
      `Aborted ${MAIN_KEY('old')} (upload ${'id-' + MAIN_KEY('old')}, 30h old)`
    );
    expect(mockInfo).toHaveBeenCalledWith('Aborted 1 incomplete upload(s).');
  });

  it('escapes control characters in an upload key before it goes to the log', async () => {
    const evil = 'octo/app/refs%2Fheads%2Fmain/k\n::error title=injected::x/v1/cache.tar.zst';
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [upload(evil, hoursAgo(30))],
      IsTruncated: false,
    });

    await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    const lines = mockInfo.mock.calls.map(([message]) => message);
    expect(lines.filter((line) => line.includes('\n'))).toEqual([]);
    expect(lines.some((line) => line.startsWith('Aborted ') && line.includes('k\\n::error'))).toBe(
      true
    );
  });

  it('warns with the count of the archive uploads it skips because they have no Initiated time', async () => {
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        upload(MAIN_KEY('a'), undefined),
        upload(MAIN_KEY('b'), undefined),
        upload(MAIN_KEY('old'), hoursAgo(30)),
        // Not a cache archive key: it is not counted.
        upload('octo/app/refs%2Fheads%2Fmain/k/v1/notes.txt', undefined),
      ],
      IsTruncated: false,
    });

    const result = await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result.abortedUploads).toBe(1);
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Skipped 2 incomplete upload(s)')
    );
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('SeaweedFS'));
  });

  it('gives no skip warning when every listed upload has an Initiated time', async () => {
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [upload(MAIN_KEY('old'), hoursAgo(30))],
      IsTruncated: false,
    });
    await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('follows the key and upload id markers across pages', async () => {
    s3Mock
      .on(ListMultipartUploadsCommand)
      .resolvesOnce({
        Uploads: [upload(MAIN_KEY('a'), hoursAgo(50))],
        IsTruncated: true,
        NextKeyMarker: 'km',
        NextUploadIdMarker: 'um',
      })
      .resolvesOnce({ Uploads: [upload(MAIN_KEY('b'), hoursAgo(50))], IsTruncated: false });

    const result = await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    const calls = s3Mock.commandCalls(ListMultipartUploadsCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(2);
    expect(calls[0].KeyMarker).toBeUndefined();
    expect(calls[1]).toMatchObject({ KeyMarker: 'km', UploadIdMarker: 'um' });
    expect(result.abortedUploads).toBe(2);
  });

  it('lists but does not abort in a dry run', async () => {
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [upload(MAIN_KEY('old'), hoursAgo(30))],
      IsTruncated: false,
    });
    const result = await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: true, now: NOW }
    );
    expect(aborted()).toEqual([]);
    expect(result.abortedUploads).toBe(1);
    expect(mockInfo).toHaveBeenCalledWith(
      `Would abort ${MAIN_KEY('old')} (upload ${'id-' + MAIN_KEY('old')}, 30h old)`
    );
    expect(mockInfo).toHaveBeenCalledWith('Would abort 1 incomplete upload(s).');
  });

  it('does not list uploads when the rule is not set', async () => {
    const result = await pruneCaches(
      { storage, template: templateFor() },
      { olderThanDays: 5, ref: MAIN, dryRun: false, now: NOW }
    );
    expect(s3Mock.commandCalls(ListMultipartUploadsCommand)).toHaveLength(0);
    expect(result.abortedUploads).toBe(0);
  });

  it('warns and goes on when the provider cannot list uploads', async () => {
    const notImplemented = Object.assign(new Error('A header you provided is not implemented'), {
      name: 'NotImplemented',
    });
    s3Mock.on(ListMultipartUploadsCommand).rejects(notImplemented);
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [object(MAIN_KEY('a'), 100, daysAgo(10))],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await pruneCaches(
      { storage, template: templateFor() },
      { olderThanDays: 5, abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Could not list incomplete multipart uploads')
    );
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('NotImplemented'));
    expect(result.abortedUploads).toBe(0);
    expect(result.pruned).toHaveLength(1);
  });

  it('ignores an upload that finished before the abort and warns on other abort errors', async () => {
    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        upload(MAIN_KEY('done'), hoursAgo(30), 'done'),
        upload(MAIN_KEY('denied'), hoursAgo(30), 'denied'),
        upload(MAIN_KEY('ok'), hoursAgo(30), 'ok'),
      ],
      IsTruncated: false,
    });
    s3Mock
      .on(AbortMultipartUploadCommand, { UploadId: 'done' })
      .rejects(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));
    s3Mock
      .on(AbortMultipartUploadCommand, { UploadId: 'denied' })
      .rejects(Object.assign(new Error('no'), { name: 'AccessDenied' }));

    const result = await pruneCaches(
      { storage, template: templateFor() },
      { abortUploadsOlderThanHours: 24, ref: MAIN, dryRun: false, now: NOW }
    );

    expect(result.abortedUploads).toBe(1);
    expect(mockWarning).toHaveBeenCalledTimes(1);
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining(MAIN_KEY('denied')));
  });
});
