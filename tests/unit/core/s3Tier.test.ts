import { jest } from '@jest/globals';
import type { S3Client } from '@aws-sdk/client-s3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import type { CompressionConfig } from '../../../src/archive/compression';
import type { ResolvedCachePaths } from '../../../src/archive/paths';
import type { ArchiveCommand, ArchivePlan, TarTool } from '../../../src/archive/tar';
import type { CacheConfig } from '../../../src/core/config';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import { computeCacheVersion } from '../../../src/core/version';
import type { StorageContext } from '../../../src/storage/client';
import type { CacheObjectMetadata, ObjectStreamResult } from '../../../src/storage/operations';
import type { PartDownloadOptions } from '../../../src/storage/parallelDownload';
import { makeTempDir, removeDir } from '../../support/tempTree';

const mockWarning = jest.fn<(message: string) => void>();
const mockCreateStorageContext = jest.fn<(options: { maxAttempts: number }) => StorageContext>();
const mockGetCompressionConfig = jest.fn<() => Promise<CompressionConfig>>();
const mockResolveCachePaths =
  jest.fn<(patterns: readonly string[], workspace?: string) => Promise<ResolvedCachePaths>>();
const mockCreateArchive =
  jest.fn<
    (
      archivePath: string,
      entries: readonly string[],
      compression: CompressionConfig,
      workspace: string
    ) => Promise<void>
  >();
const mockExtractArchive =
  jest.fn<
    (archivePath: string, compression: CompressionConfig, workspace: string) => Promise<void>
  >();
const mockGetArchiveSize = jest.fn<(archivePath: string) => number>();
const mockCheckObjectExists =
  jest.fn<(client: S3Client, bucket: string, key: string) => Promise<CacheObjectMetadata | null>>();
const mockFindNewestObject =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      prefix: string,
      accept: (key: string) => boolean
    ) => Promise<CacheObjectMetadata | undefined>
  >();
const mockListObjects =
  jest.fn<(client: S3Client, bucket: string, prefix: string) => Promise<CacheObjectMetadata[]>>();
const mockDownloadFile =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      destination: string
    ) => Promise<{ metadata?: Record<string, string> }>
  >();
const mockUploadFile =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      source: string,
      chunkSize?: number,
      options?: { metadata?: Record<string, string>; ifNoneMatch?: string; tagging?: string }
    ) => Promise<{ size: number; etag?: string }>
  >();
const mockSha256File = jest.fn<(filePath: string) => Promise<string>>();
const mockReplaceObjectMetadata =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      metadata: Record<string, string>,
      ifMatch?: string
    ) => Promise<{ etag?: string }>
  >();
const mockPutObjectTags =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      tags: { Key: string; Value: string }[]
    ) => Promise<void>
  >();
const realSha256Tap = () => {
  const hash = crypto.createHash('sha256');
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, digest: () => hash.digest('hex') };
};
const mockCreateSha256Tap = jest.fn(realSha256Tap);
const realByteCounter = () => {
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, count: () => total };
};
const mockCreateByteCounter = jest.fn(realByteCounter);

const mockInfo = jest.fn<(message: string) => void>();
const mockDebug = jest.fn<(message: string) => void>();

// Streaming (Task 8) mocks.
const mockFindTar = jest.fn<() => Promise<TarTool>>();
const mockUsesSeparateZstd =
  jest.fn<(plan: Pick<ArchivePlan, 'tar' | 'platform' | 'compression'>) => boolean>();
const mockBuildCreateCommands = jest.fn<(plan: Record<string, unknown>) => ArchiveCommand[]>();
const mockBuildExtractCommands = jest.fn<(plan: Record<string, unknown>) => ArchiveCommand[]>();
const mockFormatManifest = jest.fn<(entries: readonly string[]) => string>();

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: string) => void;
  exitCode: number | null;
  signalCode: string | null;
}
const makeFakeChild = (): FakeChild => ({
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  stdin: new PassThrough(),
  kill: jest.fn(),
  exitCode: null,
  signalCode: null,
});
const mockSpawnArchiveCommand = jest.fn<(command: ArchiveCommand, stdio: unknown) => FakeChild>();
const mockWaitForExit = jest.fn<(child: FakeChild) => Promise<number>>();
const mockKillIfRunning = jest.fn<(child: FakeChild) => void>();
const mockWaitForExitAfterKill =
  jest.fn<(child: FakeChild, settle: Promise<unknown>) => Promise<void>>();
const mockCaptureStderrTail =
  jest.fn<(stream: unknown, maxLines?: number) => { lines(): string[] }>();

const mockGetObjectStream =
  jest.fn<(client: S3Client, bucket: string, key: string) => Promise<ObjectStreamResult>>();
interface FakeUpload {
  done: () => Promise<{ ETag?: string }>;
  abort: () => Promise<unknown>;
}
const mockCreateStreamUpload =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      body: Readable,
      chunkSize?: number,
      options?: { ifNoneMatch?: string; tagging?: string }
    ) => FakeUpload
  >();

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
  info: mockInfo,
  warning: mockWarning,
}));
jest.unstable_mockModule('../../../src/storage/client', () => ({
  createStorageContext: mockCreateStorageContext,
}));
jest.unstable_mockModule('../../../src/archive/compression', () => ({
  getCompressionConfig: mockGetCompressionConfig,
}));
jest.unstable_mockModule('../../../src/archive/paths', () => ({
  resolveCachePaths: mockResolveCachePaths,
  getWorkspace: (env: NodeJS.ProcessEnv = process.env) => env.GITHUB_WORKSPACE || '/ws',
}));
jest.unstable_mockModule('../../../src/archive/tar', () => ({
  createArchive: mockCreateArchive,
  extractArchive: mockExtractArchive,
  getArchiveSize: mockGetArchiveSize,
  findTar: mockFindTar,
  usesSeparateZstd: mockUsesSeparateZstd,
  buildCreateCommands: mockBuildCreateCommands,
  buildExtractCommands: mockBuildExtractCommands,
  formatManifest: mockFormatManifest,
}));
jest.unstable_mockModule('../../../src/archive/stream', () => ({
  spawnArchiveCommand: mockSpawnArchiveCommand,
  waitForExit: mockWaitForExit,
  killIfRunning: mockKillIfRunning,
  waitForExitAfterKill: mockWaitForExitAfterKill,
  captureStderrTail: mockCaptureStderrTail,
  createByteCounter: () => mockCreateByteCounter(),
}));
jest.unstable_mockModule('../../../src/storage/operations', () => ({
  checkObjectExists: mockCheckObjectExists,
  findNewestObject: mockFindNewestObject,
  listObjects: mockListObjects,
  downloadFile: mockDownloadFile,
  uploadFile: mockUploadFile,
  getObjectStream: mockGetObjectStream,
  createStreamUpload: mockCreateStreamUpload,
  replaceObjectMetadata: mockReplaceObjectMetadata,
  putObjectTags: mockPutObjectTags,
}));
const mockDownloadFileInParts =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      destination: string,
      options: PartDownloadOptions
    ) => Promise<{ metadata?: Record<string, string>; parts: number }>
  >();
const mockOpenObjectPartsStream =
  jest.fn<
    (
      client: S3Client,
      bucket: string,
      key: string,
      options: PartDownloadOptions
    ) => Promise<{ body: Readable; metadata?: Record<string, string>; parts: number }>
  >();
const realParallelDownload = await import('../../../src/storage/parallelDownload');
jest.unstable_mockModule('../../../src/storage/parallelDownload', () => ({
  ...realParallelDownload,
  downloadFileInParts: mockDownloadFileInParts,
  openObjectPartsStream: mockOpenObjectPartsStream,
}));
const { RangeNotSupportedError } = realParallelDownload;

jest.unstable_mockModule('../../../src/archive/checksum', () => ({
  sha256File: mockSha256File,
  createSha256Tap: () => mockCreateSha256Tap(),
}));

const { buildS3Tier, findS3Match, listCandidates, restoreFromS3, saveToS3 } = await import(
  '../../../src/core/s3Tier'
);
const { buildExplainReport } = await import('../../../src/core/explain');
type S3Tier = Awaited<ReturnType<typeof buildS3Tier>>;

const FEATURE = 'refs/heads/feature';
const MAIN = 'refs/heads/main';
const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const zstd: CompressionConfig = { method: 'zstd', archiveFilename: 'cache.tar.zst' };
const gzip: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };
const VERSION = computeCacheVersion(['~/.npm'], 'zstd', false);
const storage = {
  client: {} as S3Client,
  bucket: 'bucket',
  providerConfig: { provider: 'seaweedfs', region: 'us-east-1', forcePathStyle: true },
} as StorageContext;
const templateFor = (scopedToRef: boolean) =>
  compileKeyTemplate({
    pattern: PATTERN,
    repository: 'octo/app',
    prefix: '',
    scopedToRepository: true,
    scopedToRef,
    version: VERSION,
    archiveFilename: 'cache.tar.zst',
    env: {},
  });
const tier = (overrides: Partial<S3Tier> = {}): S3Tier => ({
  storage,
  template: templateFor(true),
  restoreRefs: [FEATURE, MAIN],
  saveRef: FEATURE,
  compression: zstd,
  workspace: '/ws',
  streamRetries: 0,
  streaming: false,
  download: { concurrency: 8, partSize: 8 * 1024 * 1024 },
  upload: { concurrency: 8, partSize: 64 * 1024 * 1024 },
  metadata: {},
  tags: [],
  ...overrides,
});

// A tiny in-memory bucket behind the mocked HEAD and paginated-list operations.
const objects = new Map<string, { size: number; lastModified: Date; etag: string }>();
const put = (ref: string, key: string, minute: number, version = VERSION): string => {
  const objectKey = `octo/app/${encodeURIComponent(ref)}/${key}/${version}/cache.tar.zst`;
  objects.set(objectKey, {
    size: 100 + minute,
    lastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
    etag: `"${key}"`,
  });
  return objectKey;
};

beforeEach(() => {
  objects.clear();
  jest.clearAllMocks();
  delete storage.conditionalWriteUnsupported;
  delete storage.objectTaggingUnsupported;
  mockCheckObjectExists.mockImplementation(async (_client, _bucket, key) => {
    const found = objects.get(key);
    return found ? { key, ...found } : null;
  });
  mockFindNewestObject.mockImplementation(async (_client, _bucket, prefix, accept) => {
    let newest: CacheObjectMetadata | undefined;
    for (const [key, found] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (
        key.startsWith(prefix) &&
        accept(key) &&
        (!newest || found.lastModified > (newest.lastModified as Date))
      ) {
        newest = { key, size: found.size, lastModified: found.lastModified, etag: found.etag };
      }
    }
    return newest;
  });
  mockListObjects.mockImplementation(async (_client, _bucket, prefix) =>
    [...objects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, found]) => ({
        key,
        size: found.size,
        lastModified: found.lastModified,
        etag: found.etag,
      }))
  );
  mockDownloadFile.mockResolvedValue({});
  mockDownloadFileInParts.mockResolvedValue({ parts: 3 });
  mockExtractArchive.mockResolvedValue();
  mockCreateArchive.mockResolvedValue();
  mockGetArchiveSize.mockReturnValue(2048);
  mockUploadFile.mockResolvedValue({ size: 2048, etag: '"new"' });
  mockResolveCachePaths.mockResolvedValue({ entries: ['node_modules'], skipped: [] });
  mockSha256File.mockResolvedValue('archive-sha256');
  mockReplaceObjectMetadata.mockResolvedValue({});
  mockPutObjectTags.mockResolvedValue(undefined);
  mockCreateSha256Tap.mockImplementation(realSha256Tap);
  mockCreateByteCounter.mockImplementation(realByteCounter);

  // Streaming (Task 8) defaults: GNU tar on Linux, a single-command plan, no fallback.
  mockFindTar.mockResolvedValue({ path: '/usr/bin/tar', flavor: 'gnu' });
  mockUsesSeparateZstd.mockReturnValue(false);
  mockBuildCreateCommands.mockImplementation((plan) => [
    { tool: (plan.tar as TarTool).path, args: ['-cf', plan.archivePath as string] },
  ]);
  mockBuildExtractCommands.mockImplementation((plan) => [
    { tool: (plan.tar as TarTool).path, args: ['-xf', plan.archivePath as string] },
  ]);
  mockFormatManifest.mockImplementation((entries) => `${entries.join('\n')}\n`);
  mockCaptureStderrTail.mockReturnValue({ lines: () => [] });
  mockKillIfRunning.mockImplementation(() => undefined);
  // Delegates to killIfRunning so existing assertions on it still see the call, and awaits the
  // given `settle` promise (swallowing its outcome) so tests see the same "kill, then wait for
  // it to actually settle" ordering production code relies on, without a real 5s timeout race.
  mockWaitForExitAfterKill.mockImplementation(async (child, settle) => {
    mockKillIfRunning(child);
    await settle.then(
      () => undefined,
      () => undefined
    );
  });
  mockCreateStreamUpload.mockImplementation(() => ({
    done: jest.fn(async () => ({ ETag: '"streamed"' })),
    abort: jest.fn(async () => undefined),
  }));
});

describe('findS3Match', () => {
  it('prefers the exact key on the current ref over newer prefix matches', async () => {
    const exact = put(FEATURE, 'k', 1);
    put(FEATURE, 'k-newer', 9);
    await expect(findS3Match(tier(), 'k', ['k-'])).resolves.toEqual({
      matchedKey: 'k',
      exact: true,
      objectKey: exact,
      size: 101,
      etag: '"k"',
      ref: FEATURE,
    });
  });

  it('tries the primary key as a prefix before any restore key', async () => {
    put(FEATURE, 'k-2', 1);
    put(FEATURE, 'npm-x', 9);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'k-2',
      exact: false,
    });
  });

  it('tries restore keys in input order', async () => {
    put(FEATURE, 'b-1', 9);
    put(FEATURE, 'a-1', 1);
    await expect(findS3Match(tier(), 'k', ['a-', 'b-'])).resolves.toMatchObject({
      matchedKey: 'a-1',
    });
  });

  it('takes the newest object for a prefix', async () => {
    put(FEATURE, 'npm-1', 1);
    put(FEATURE, 'npm-2', 5);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'npm-2',
    });
  });

  it('searches the whole current ref before the default branch', async () => {
    put(MAIN, 'k', 9);
    put(FEATURE, 'npm-old', 1);
    await expect(findS3Match(tier(), 'k', ['npm-'])).resolves.toMatchObject({
      matchedKey: 'npm-old',
      ref: FEATURE,
    });
  });

  it("falls back to the default branch's cache", async () => {
    put(MAIN, 'k', 1);
    await expect(findS3Match(tier(), 'k', [])).resolves.toMatchObject({
      matchedKey: 'k',
      exact: true,
      ref: MAIN,
    });
  });

  it("never lets the default branch restore a feature branch's cache", async () => {
    put(FEATURE, 'k', 1);
    await expect(
      findS3Match(tier({ restoreRefs: [MAIN], saveRef: MAIN }), 'k', ['k'])
    ).resolves.toBeUndefined();
  });

  it('ignores objects saved with another version', async () => {
    put(FEATURE, 'k', 1, 'ffffffffffffffff');
    await expect(findS3Match(tier(), 'k', ['k'])).resolves.toBeUndefined();
  });

  it('matches keys that contain slashes by prefix', async () => {
    put(FEATURE, 'Linux/node-20/abc', 1);
    await expect(
      findS3Match(tier(), 'Linux/node-20/xyz', ['Linux/node-20/'])
    ).resolves.toMatchObject({
      matchedKey: 'Linux/node-20/abc',
    });
  });

  it('ignores refs when caches are not scoped to a ref', async () => {
    objects.set(`octo/app/k/${VERSION}/cache.tar.zst`, {
      size: 7,
      lastModified: new Date(),
      etag: '"unscoped"',
    });
    const unscoped = tier({ template: templateFor(false), restoreRefs: [''], saveRef: '' });
    await expect(findS3Match(unscoped, 'k', [])).resolves.toMatchObject({
      matchedKey: 'k',
      exact: true,
      ref: '',
    });
  });

  it("sends one ref's prefix listings together instead of one after another", async () => {
    put(MAIN, 'k-old', 1);
    let inFlight = 0;
    let peak = 0;
    const realFindNewest = mockFindNewestObject.getMockImplementation();
    mockFindNewestObject.mockImplementation(async (...args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return realFindNewest ? realFindNewest(...args) : undefined;
    });
    await findS3Match(tier(), 'k', ['k-']);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not list at all when the exact key hits', async () => {
    put(FEATURE, 'k', 1);
    await findS3Match(tier(), 'k', ['k-']);
    expect(mockFindNewestObject).not.toHaveBeenCalled();
  });

  it('keeps a prefix match on the current ref ahead of an exact match on the base ref', async () => {
    const onFeature = put(FEATURE, 'k-partial', 1);
    put(MAIN, 'k', 5);
    const match = await findS3Match(tier(), 'k', ['k-']);
    expect(match?.objectKey).toBe(onFeature);
    expect(match?.ref).toBe(FEATURE);
  });
});

describe('restoreFromS3', () => {
  it('reports a lookup-only hit without downloading', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(restoreFromS3(tier(), 'k', [], true)).resolves.toEqual({
      kind: 'hit',
      matchedKey: 'k',
      exact: true,
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockDownloadFile).not.toHaveBeenCalled();
  });

  it('reports no transferMs on a lookup-only hit, since nothing was transferred', async () => {
    put(FEATURE, 'k', 1);
    const outcome = await restoreFromS3(tier(), 'k', [], true);
    expect(outcome.kind === 'hit' && outcome.transferMs).toBeUndefined();
  });

  it('measures the download alone as transferMs, not the extraction that follows it', async () => {
    put(FEATURE, 'k', 1);
    // A clock that only the mocked download advances: a measurement taken after extractArchive
    // would read 5250, so this pins the timer to the download itself.
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockDownloadFile.mockImplementation(async () => {
      now += 250;
      return {};
    });
    mockExtractArchive.mockImplementation(async () => {
      now += 5_000;
    });
    try {
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome).toMatchObject({ kind: 'hit', matchedKey: 'k', transferMs: 250 });
    } finally {
      nowSpy.mockRestore();
    }
    expect(mockExtractArchive).toHaveBeenCalled();
  });

  it('does not log its own info line on a lookup-only hit, since restoreImpl already reports it', async () => {
    put(FEATURE, 'k', 1);
    await restoreFromS3(tier(), 'k', [], true);
    expect(mockInfo).not.toHaveBeenCalled();
  });

  it('logs an info line on a real restore', async () => {
    put(FEATURE, 'k', 1);
    await restoreFromS3(tier(), 'k', [], false);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('S3 cache hit'));
  });

  it('downloads to a temporary directory, extracts into the workspace and cleans up', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(restoreFromS3(tier(), 'k', [], false)).resolves.toMatchObject({
      kind: 'hit',
      matchedKey: 'k',
    });
    const [, bucket, key, target] = mockDownloadFile.mock.calls[0];
    expect([bucket, key, path.basename(target)]).toEqual(['bucket', objectKey, 'cache.tar.zst']);
    expect(mockExtractArchive).toHaveBeenCalledWith(target, zstd, '/ws');
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('returns a download failure as an error without extracting', async () => {
    put(FEATURE, 'k', 1);
    mockDownloadFile.mockRejectedValue(new Error('connection reset by peer'));
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('connection reset by peer');
    expect(mockExtractArchive).not.toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(mockDownloadFile.mock.calls[0][3]))).toBe(false);
  });

  it('does not repeat a download the SDK already retried', async () => {
    put(FEATURE, 'k', 1);
    mockDownloadFile.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $metadata: { httpStatusCode: 503, attempts: 4 },
      })
    );
    const outcome = await restoreFromS3(tier({ streamRetries: 3 }), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('Service Unavailable');
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
  });

  it('returns a listing failure as an error', async () => {
    mockFindNewestObject.mockRejectedValue(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
    );
    await expect(restoreFromS3(tier(), 'k', ['k-'], false)).resolves.toMatchObject({
      kind: 'error',
    });
  });

  it('reports a miss', async () => {
    await expect(restoreFromS3(tier(), 'k', ['k-'], false)).resolves.toEqual({ kind: 'miss' });
  });

  describe('integrity check', () => {
    it('extracts when the downloaded archive matches the sha256 in the object metadata', async () => {
      put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({ metadata: { 'cloud-cache-sha256': 'good-hash' } });
      mockSha256File.mockResolvedValue('good-hash');
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome.kind).toBe('hit');
      expect(mockExtractArchive).toHaveBeenCalled();
    });

    it('returns an integrity error without extracting on a sha256 mismatch', async () => {
      const objectKey = put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({ metadata: { 'cloud-cache-sha256': 'expected-hash' } });
      mockSha256File.mockResolvedValue('actual-hash');
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome).toEqual({
        kind: 'error',
        error: new Error(
          `Integrity check failed for s3://bucket/${objectKey}: expected sha256 expected-hash, got actual-hash`
        ),
      });
      expect(mockExtractArchive).not.toHaveBeenCalled();
    });

    it('skips verification and logs a debug line when the object carries no checksum metadata', async () => {
      put(FEATURE, 'k', 1);
      mockDownloadFile.mockResolvedValue({});
      const outcome = await restoreFromS3(tier(), 'k', [], false);
      expect(outcome.kind).toBe('hit');
      expect(mockSha256File).not.toHaveBeenCalled();
      expect(mockExtractArchive).toHaveBeenCalled();
      expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('sha256'));
    });
  });
});

const conditionalConflict = () =>
  Object.assign(
    new Error('A conflicting operation occurred. If using PutObject you can retry the request.'),
    { name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } }
  );
const preconditionFailed = () =>
  Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });

describe('saveToS3', () => {
  it('does not archive when the object already exists', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(saveToS3(tier(), 'k', ['node_modules'])).resolves.toEqual({
      kind: 'exists',
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockCreateArchive).not.toHaveBeenCalled();
  });

  it('skips with a path validation warning when nothing matches', async () => {
    mockResolveCachePaths.mockResolvedValue({ entries: [], skipped: [] });
    await expect(saveToS3(tier(), 'k', ['missing'])).resolves.toEqual({
      kind: 'skipped',
      reason: 'no paths matched',
    });
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Path Validation Error'));
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it('archives the resolved entries and uploads them under the current ref', async () => {
    const outcome = await saveToS3(tier({ upload: { concurrency: 8, partSize: 5_242_880 } }), 'k', [
      'node_modules',
      '!node_modules/.cache',
    ]);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'saved',
      s3: { objectKey, size: 2048, etag: '"new"' },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(mockResolveCachePaths).toHaveBeenCalledWith(
      ['node_modules', '!node_modules/.cache'],
      '/ws'
    );
    const [archivePath, entries, compression, workspace] = mockCreateArchive.mock.calls[0];
    expect([path.basename(archivePath), entries, compression, workspace]).toEqual([
      'cache.tar.zst',
      ['node_modules'],
      zstd,
      '/ws',
    ]);
    expect(mockUploadFile).toHaveBeenCalledWith(
      storage.client,
      'bucket',
      objectKey,
      archivePath,
      { concurrency: 8, partSize: 5_242_880 },
      { metadata: { 'cloud-cache-sha256': 'archive-sha256' }, ifNoneMatch: '*' }
    );
    expect(fs.existsSync(path.dirname(archivePath))).toBe(false);
  });

  it('hashes the archive and uploads its sha256 as object metadata', async () => {
    mockSha256File.mockResolvedValue(
      'c0ffee0000000000000000000000000000000000000000000000000000ffee'
    );
    await saveToS3(tier(), 'k', ['node_modules']);
    const [archivePath] = mockCreateArchive.mock.calls[0];
    expect(mockSha256File).toHaveBeenCalledWith(archivePath);
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({
      metadata: {
        'cloud-cache-sha256': 'c0ffee0000000000000000000000000000000000000000000000000000ffee',
      },
      ifNoneMatch: '*',
    });
  });

  it('sends the If-None-Match condition on the first upload of a tier', async () => {
    await saveToS3(tier(), 'k', ['node_modules']);
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toMatchObject({ ifNoneMatch: '*' });
  });

  it('returns exists and logs when the server reports a 412 precondition failure', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey, size: 2048, etag: undefined },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      `Another job saved s3://bucket/${objectKey} first; keeping its cache.`
    );
  });

  it('recognizes a precondition failure identified only by name, without a 412 status', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Precondition Failed'), {
        name: 'PreconditionFailed',
      })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('exists');
  });

  it('retries once without the condition when the server rejects If-None-Match with a 501', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'saved',
      s3: { objectKey, size: 2048, etag: '"fallback"' },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    const [, , , , , firstOptions] = mockUploadFile.mock.calls[0];
    const [, , , , , secondOptions] = mockUploadFile.mock.calls[1];
    expect(firstOptions).toMatchObject({ ifNoneMatch: '*' });
    expect(secondOptions).toEqual({ metadata: { 'cloud-cache-sha256': 'archive-sha256' } });
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('If-None-Match'));
  });

  it('retries once without the condition when the server rejects it as InvalidArgument mentioning If-None-Match', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Header "If-None-Match" is not supported for this operation'), {
          name: 'InvalidArgument',
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
  });

  it('does not treat an unrelated InvalidArgument as an unsupported condition', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Some other invalid argument'), { name: 'InvalidArgument' })
    );
    const outcome = await saveToS3(tier(), 'k', ['node_modules']);
    expect(outcome.kind).toBe('error');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('remembers a server that rejects the condition, so a later save in the same tier skips it', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"first"' })
      .mockResolvedValueOnce({ size: 2048, etag: '"second"' });

    const first = await saveToS3(tier(), 'k', ['node_modules']);
    expect(first.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(2);

    mockUploadFile.mockClear();
    const second = await saveToS3(tier(), 'k2', ['node_modules']);
    expect(second.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({ metadata: { 'cloud-cache-sha256': 'archive-sha256' } });
  });

  it('sends user metadata next to the sha256 and the encoded tags', async () => {
    const tierWithTags = tier({
      metadata: { team: 'x' },
      tags: [{ Key: 'repo', Value: 'acme/app' }],
    });
    await saveToS3(tierWithTags, 'k', ['node_modules']);
    const options = mockUploadFile.mock.calls[0][5];
    expect(options?.metadata).toEqual({ team: 'x', 'cloud-cache-sha256': expect.any(String) });
    expect(options?.tagging).toBe('repo=acme%2Fapp');
  });

  it('sends no Tagging header when no tags are configured', async () => {
    await saveToS3(tier(), 'k', ['node_modules']);
    expect(mockUploadFile.mock.calls[0][5]?.tagging).toBeUndefined();
  });

  it('retries once without tags when the server does not support tagging, warns, and remembers it', async () => {
    const tierWithTags = tier({ tags: [{ Key: 'a', Value: 'b' }] });
    const unsupported = Object.assign(new Error('NotImplemented'), {
      name: 'NotImplemented',
      $metadata: { httpStatusCode: 501 },
    });
    mockUploadFile.mockRejectedValueOnce(unsupported).mockResolvedValueOnce({ size: 3, etag: 'e' });
    const outcome = await saveToS3(tierWithTags, 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(2);
    expect(mockUploadFile.mock.calls[0][5]?.tagging).toBe('a=b');
    expect(mockUploadFile.mock.calls[1][5]?.tagging).toBeUndefined();
    expect(mockUploadFile.mock.calls[1][5]?.ifNoneMatch).toBe('*');
    expect(tierWithTags.storage.objectTaggingUnsupported).toBe(true);
    expect(mockWarning).toHaveBeenCalledWith(
      's3://bucket could not store object tags (NotImplemented); saved without them.'
    );
  });

  it('names the error message in the warning when the error carries no distinct name', async () => {
    const tierWithTags = tier({ tags: [{ Key: 'a', Value: 'b' }] });
    mockUploadFile
      .mockRejectedValueOnce(new Error('x-amz-tagging is not supported'))
      .mockResolvedValueOnce({ size: 3, etag: 'e' });

    await saveToS3(tierWithTags, 'k', ['node_modules']);

    expect(mockWarning).toHaveBeenCalledWith(
      's3://bucket could not store object tags (x-amz-tagging is not supported); saved without them.'
    );
  });

  it('keeps the tags when the untagged retry hits the same 501, which was about the condition', async () => {
    const tierWithTags = tier({ tags: [{ Key: 'a', Value: 'b' }] });
    const notImplemented = () =>
      Object.assign(new Error('Not Implemented'), {
        name: 'NotImplemented',
        $metadata: { httpStatusCode: 501 },
      });
    mockUploadFile
      .mockRejectedValueOnce(notImplemented())
      .mockRejectedValueOnce(notImplemented())
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });

    const outcome = await saveToS3(tierWithTags, 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"fallback"' } });
    expect(mockUploadFile).toHaveBeenCalledTimes(3);
    // The unconditional retry sends the tags again: nothing proved the server rejects them.
    expect(mockUploadFile.mock.calls[2][5]?.tagging).toBe('a=b');
    expect(mockUploadFile.mock.calls[2][5]?.ifNoneMatch).toBeUndefined();
    expect(tierWithTags.storage.objectTaggingUnsupported).toBeUndefined();
    expect(storage.conditionalWriteUnsupported).toBe(true);
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('returns exists, and leaves the tagging flag alone, when a tagged save gets a 412', async () => {
    const tierWithTags = tier({ tags: [{ Key: 'a', Value: 'b' }] });
    mockUploadFile.mockRejectedValue(preconditionFailed());

    const outcome = await saveToS3(tierWithTags, 'k', ['node_modules']);

    expect(outcome.kind).toBe('exists');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(tierWithTags.storage.objectTaggingUnsupported).toBeUndefined();
    expect(mockWarning).not.toHaveBeenCalled();
  });

  it('warns once, and omits tags upfront, for a later save through the same tier', async () => {
    const tierWithTags = tier({ tags: [{ Key: 'a', Value: 'b' }] });
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('NotImplemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValue({ size: 3, etag: 'e' });
    await saveToS3(tierWithTags, 'k', ['node_modules']);
    mockUploadFile.mockClear();

    const second = await saveToS3(tierWithTags, 'k2', ['node_modules']);

    expect(second.kind).toBe('saved');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockUploadFile.mock.calls[0][5]?.tagging).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a 501 for the If-None-Match condition for a tagging failure when no tags are set', async () => {
    mockUploadFile
      .mockRejectedValueOnce(
        Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        })
      )
      .mockResolvedValueOnce({ size: 2048, etag: '"fallback"' });

    const outcome = await saveToS3(tier(), 'k', ['node_modules']);

    expect(outcome.kind).toBe('saved');
    expect(storage.conditionalWriteUnsupported).toBe(true);
    expect(storage.objectTaggingUnsupported).toBeUndefined();
    expect(mockUploadFile.mock.calls[1][5]?.ifNoneMatch).toBeUndefined();
    expect(mockWarning).not.toHaveBeenCalled();
  });

  describe('a 409 ConditionalRequestConflict during the conditional write', () => {
    it('retries the conditional upload once and reports saved when the retry succeeds', async () => {
      mockUploadFile
        .mockRejectedValueOnce(conditionalConflict())
        .mockResolvedValueOnce({ size: 2048, etag: '"retried"' });

      const outcome = await saveToS3(tier(), 'k', ['node_modules']);

      expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"retried"' } });
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
      for (const [, , , , , options] of mockUploadFile.mock.calls) {
        expect(options).toMatchObject({ ifNoneMatch: '*' });
      }
      expect(storage.conditionalWriteUnsupported).toBeUndefined();
    });

    it('recognizes the conflict by its name alone', async () => {
      mockUploadFile
        .mockRejectedValueOnce(
          Object.assign(new Error('conflict'), { name: 'ConditionalRequestConflict' })
        )
        .mockResolvedValueOnce({ size: 2048, etag: '"retried"' });
      await expect(saveToS3(tier(), 'k', ['node_modules'])).resolves.toMatchObject({
        kind: 'saved',
      });
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
    });

    it('reports exists when the retry gets a 412', async () => {
      mockUploadFile
        .mockRejectedValueOnce(conditionalConflict())
        .mockRejectedValueOnce(preconditionFailed());

      const outcome = await saveToS3(tier(), 'k', ['node_modules']);

      expect(outcome.kind).toBe('exists');
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
    });

    it('returns an error, without a third attempt, when the retry conflicts again', async () => {
      mockUploadFile.mockRejectedValue(conditionalConflict());

      const outcome = await saveToS3(tier(), 'k', ['node_modules']);

      expect(outcome.kind).toBe('error');
      expect(outcome.kind === 'error' ? outcome.error.message : '').toContain(
        'A conflicting operation occurred'
      );
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
    });
  });

  it('does not repeat an upload the SDK already retried', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $metadata: { httpStatusCode: 503, attempts: 4 },
      })
    );
    await expect(
      saveToS3(tier({ streamRetries: 3 }), 'k', ['node_modules'])
    ).resolves.toMatchObject({ kind: 'error' });
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it('returns an upload failure as an error', async () => {
    mockUploadFile.mockRejectedValue(
      Object.assign(new Error('Access Denied'), { name: 'AccessDenied' })
    );
    await expect(saveToS3(tier(), 'k', ['node_modules'])).resolves.toMatchObject({ kind: 'error' });
  });
});

describe('buildS3Tier', () => {
  const config: CacheConfig = {
    primaryKey: 'k',
    paths: ['~/.npm'],
    restoreKeys: [],
    lookupOnly: false,
    failOnCacheMiss: false,
    readOnly: false,
    enableCrossOsArchive: false,
    uploadChunkSize: undefined,
    uploadConcurrency: 8,
    s3KeyPattern: PATTERN,
    prefix: '',
    scopedToRepository: true,
    scopedToRef: true,
    retryEnabled: true,
    retryCount: 3,
    useFallback: false,
    dualCache: false,
    restorePriority: 's3-first',
    dualCacheStrategy: 'backfill',
    dualCacheStrict: false,
    streaming: false,
    downloadConcurrency: 8,
    downloadChunkSize: 8388608,
    jobSummary: true,
    metadata: {},
    tags: [],
    explain: false,
    metricsFile: '',
  };
  let eventDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    eventDir = makeTempDir('event');
    fs.writeFileSync(
      path.join(eventDir, 'event.json'),
      JSON.stringify({ repository: { default_branch: 'main' } })
    );
    env = {
      GITHUB_REF: FEATURE,
      GITHUB_EVENT_PATH: path.join(eventDir, 'event.json'),
      GITHUB_REPOSITORY: 'octo/app',
      GITHUB_WORKSPACE: '/ws',
    };
    mockCreateStorageContext.mockReturnValue(storage);
    mockGetCompressionConfig.mockResolvedValue(zstd);
  });

  afterEach(() => removeDir(eventDir));

  it('scopes to the current ref and searches the default branch', async () => {
    const built = await buildS3Tier(config, env);
    expect(mockCreateStorageContext).toHaveBeenCalledWith({ maxAttempts: 4 });
    expect(built).toMatchObject({
      restoreRefs: [FEATURE, MAIN],
      saveRef: FEATURE,
      workspace: '/ws',
      streamRetries: 3,
    });
    expect(built.template.objectKey(FEATURE, 'k')).toBe(
      `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`
    );
  });

  it('does not scope by ref without GITHUB_REF or with scoped-to-ref: false', async () => {
    for (const built of [
      await buildS3Tier(config, { ...env, GITHUB_REF: undefined }),
      await buildS3Tier({ ...config, scopedToRef: false }, env),
    ]) {
      expect(built).toMatchObject({ restoreRefs: [''], saveRef: '' });
      expect(built.template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    }
  });

  it('uses the compression method the restore step persisted instead of detecting it', async () => {
    for (const persisted of ['gzip', 'zstd'] as const) {
      mockGetCompressionConfig.mockResolvedValue(persisted === 'gzip' ? zstd : gzip);
      const built = await buildS3Tier(config, env, { compression: persisted });
      expect(built.compression).toEqual(persisted === 'gzip' ? gzip : zstd);
      const version = computeCacheVersion(['~/.npm'], persisted, false);
      expect(built.template.objectKey(FEATURE, 'k')).toBe(
        `octo/app/refs%2Fheads%2Ffeature/k/${version}/${built.compression.archiveFilename}`
      );
    }
    expect(mockGetCompressionConfig).not.toHaveBeenCalled();
  });

  it('detects compression when nothing usable was persisted', async () => {
    for (const persisted of [undefined, '', 'brotli']) {
      const built = await buildS3Tier(config, env, { compression: persisted });
      expect(built.compression).toEqual(zstd);
    }
    expect(mockGetCompressionConfig).toHaveBeenCalledTimes(3);
  });

  it('searches one ref when the pattern has no ${ref}, instead of repeating each lookup', async () => {
    const built = await buildS3Tier(
      { ...config, s3KeyPattern: '${GITHUB_REPOSITORY}/${key}/${version}/${archive_filename}' },
      env
    );
    expect(built).toMatchObject({ restoreRefs: [''], saveRef: '' });
    expect(built.template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);

    objects.set(`octo/app/k-1/${VERSION}/cache.tar.zst`, {
      size: 7,
      lastModified: new Date(),
      etag: '"k-1"',
    });
    await expect(findS3Match(built, 'k', ['k-'])).resolves.toMatchObject({ matchedKey: 'k-1' });
    expect(mockCheckObjectExists).toHaveBeenCalledTimes(1);
  });

  it('makes a single attempt when retries are disabled', async () => {
    const built = await buildS3Tier({ ...config, retryEnabled: false }, env);
    expect(mockCreateStorageContext).toHaveBeenCalledWith({ maxAttempts: 1 });
    expect(built.streamRetries).toBe(0);
  });

  it('surfaces pattern warnings', async () => {
    await buildS3Tier({ ...config, s3KeyPattern: '${key}/${archive_filename}' }, env);
    expect(mockWarning).toHaveBeenCalledTimes(2);
  });

  it('rejects a pattern without ${key}', async () => {
    await expect(
      buildS3Tier({ ...config, s3KeyPattern: '${archive_filename}' }, env)
    ).rejects.toThrow('exactly once');
  });

  it.each([true, false])('carries the streaming config flag through (%s)', async (streaming) => {
    const built = await buildS3Tier({ ...config, streaming }, env);
    expect(built.streaming).toBe(streaming);
  });
});

describe('saveToS3 streaming', () => {
  it('streams the archive from tar straight into the upload, without a temporary file', async () => {
    let child: FakeChild | undefined;
    let uploadedBytes: Buffer | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('streamed-archive-bytes'));
      return 0;
    });
    mockCreateStreamUpload.mockImplementation((_client, _bucket, _key, body) => ({
      done: jest.fn(async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of body as Readable) {
          chunks.push(chunk as Buffer);
        }
        uploadedBytes = Buffer.concat(chunks);
        return { ETag: '"streamed"' };
      }),
      abort: jest.fn(async () => undefined),
    }));

    const outcome = await saveToS3(
      tier({ streaming: true, upload: { concurrency: 8, partSize: 5_242_880 } }),
      'k',
      ['node_modules']
    );

    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'saved',
      s3: { objectKey, size: 'streamed-archive-bytes'.length, etag: '"streamed"' },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(uploadedBytes?.toString()).toBe('streamed-archive-bytes');
    expect(mockCreateArchive).not.toHaveBeenCalled();
    expect(mockGetArchiveSize).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();

    expect(mockFindTar).toHaveBeenCalled();
    const [command, stdio] = mockSpawnArchiveCommand.mock.calls[0];
    expect(command.tool).toBe('/usr/bin/tar');
    expect(stdio).toEqual(['ignore', 'pipe', 'pipe']);
    const [plan] = mockBuildCreateCommands.mock.calls[0];
    expect(plan).toMatchObject({ archivePath: '-', workspace: '/ws', compression: 'zstd' });

    const call = mockCreateStreamUpload.mock.calls[0];
    expect(call[1]).toBe('bucket');
    expect(call[2]).toBe(objectKey);
    expect(call[4]).toEqual({ concurrency: 8, partSize: 5_242_880 });
    expect(call[5]).toEqual({ ifNoneMatch: '*' });
  });

  it('never lets the upload observe the body as complete when tar closes with a non-zero code', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      // tar produced some (truncated) output before failing; its stdout still reaches EOF.
      c.stdout.end(Buffer.from('partial-archive'));
      return 2;
    });
    const abort = jest.fn(async () => undefined);
    // A real Upload reads the body until it ends; actually consuming it here (rather than just
    // attaching a `finished()` listener nobody drives) is what would let a `sawEnd = true`
    // moment ever happen for a real, unread Transform, whose 'end' never fires without a reader.
    let sawEnd = false;
    // saveToS3Streaming only needs ONE of upload.done()/finalized to reject to return, so it can
    // return before done()'s own consumption of the body has actually finished draining. Capture
    // done()'s promise so the test can wait for it to fully settle before trusting `sawEnd`,
    // rather than relying on which of the two happens to settle first.
    let doneSettled: Promise<unknown> | undefined;
    mockCreateStreamUpload.mockImplementation((_client, _bucket, _key, body) => ({
      done: jest.fn(() => {
        const settled = (async () => {
          for await (const _chunk of body as Readable) {
            // Drain it, exactly as the real Upload would while buffering parts.
          }
          // Only reached if the body ended cleanly, without the destroy(err) the fix requires.
          sawEnd = true;
          return { ETag: '"should-not-be-committed"' };
        })();
        doneSettled = settled;
        return settled;
      }),
      abort,
    }));

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    await doneSettled?.catch(() => undefined);

    expect(sawEnd).toBe(false);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('tar exited with code 2');
    expect(abort).toHaveBeenCalled();
  });

  it('does not spawn tar when the object already exists', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    await expect(saveToS3(tier({ streaming: true }), 'k', ['node_modules'])).resolves.toEqual({
      kind: 'exists',
      s3: { objectKey, size: 101, etag: '"k"' },
    });
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
  });

  it('skips the If-None-Match condition once the tier has learned it is unsupported', async () => {
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('x'));
      return 0;
    });
    await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    const [, , , , , options] = mockCreateStreamUpload.mock.calls[0];
    expect(options).toEqual({ ifNoneMatch: undefined });
  });

  it('returns exists and logs when the server reports a 412 precondition failure', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    // Like the real Upload, which only sends the conditional PutObject/Complete once the body
    // has ended, read the whole body before the 412 arrives.
    mockCreateStreamUpload.mockImplementation((_client, _bucket, _key, body) => ({
      done: jest.fn(async () => {
        for await (const _chunk of body as Readable) {
          // Drain it.
        }
        throw Object.assign(new Error('At least one of the pre-conditions did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }),
      abort: jest.fn(async () => undefined),
    }));

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey, size: 'archive-body'.length, etag: undefined },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      `Another job saved s3://bucket/${objectKey} first; keeping its cache.`
    );
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
  });

  it('falls back to a file-mode save, sending no condition, when the server rejects If-None-Match outright', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(async () => {
        throw Object.assign(new Error('Not Implemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        });
      }),
      abort: jest.fn(async () => undefined),
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome.kind).toBe('saved');
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('If-None-Match'));
    expect(storage.conditionalWriteUnsupported).toBe(true);
    // The fallback is a plain file-mode save: exactly one archive and one upload, unconditional.
    expect(mockCreateArchive).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({ metadata: { 'cloud-cache-sha256': 'archive-sha256' } });
  });

  it('attaches the streamed archive sha256 and user metadata after a successful upload', async () => {
    const archiveBody = Buffer.from('streamed-archive-bytes');
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(archiveBody);
      return 0;
    });

    const outcome = await saveToS3(tier({ streaming: true, metadata: { team: 'x' } }), 'k', [
      'node_modules',
    ]);

    expect(outcome.kind).toBe('saved');
    expect(mockReplaceObjectMetadata).toHaveBeenCalledWith(
      expect.anything(),
      'bucket',
      expect.stringContaining('cache.tar.zst'),
      {
        team: 'x',
        'cloud-cache-sha256': crypto.createHash('sha256').update(archiveBody).digest('hex'),
      },
      // The ETag the upload just wrote, so the copy cannot stamp another writer's body.
      '"streamed"'
    );
  });

  it('reports the ETag the metadata copy produced, which supersedes the upload one', async () => {
    // Forces the copy path (rather than the default tag) so this test can exercise it in
    // isolation: tagging is covered separately above.
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockReplaceObjectMetadata.mockResolvedValue({ etag: '"copied"' });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"copied"' } });
  });

  it('skips the metadata copy, and warns, for an archive over the 5 GiB copy limit', async () => {
    // Forces the copy path (rather than the default tag) so this test can exercise it in
    // isolation: tagging is covered separately above.
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('x'));
      return 0;
    });
    // A real 5 GiB stream is not worth producing: only the reported count drives the decision.
    mockCreateByteCounter.mockImplementation(() => ({
      ...realByteCounter(),
      count: () => 5 * 1024 * 1024 * 1024 + 1,
    }));

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"streamed"' } });
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const objectKey = `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`;
    expect(mockWarning).toHaveBeenCalledWith(
      `Saved s3://bucket/${objectKey} but could not attach metadata: archives over 5 GiB cannot be copied in one request.`
    );
  });

  it('keeps the save successful and warns when the metadata copy fails', async () => {
    // Forces the copy path (rather than the default tag) so this test can exercise it in
    // isolation: tagging is covered separately above.
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockReplaceObjectMetadata.mockRejectedValueOnce(new Error('NotImplemented'));

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"streamed"' } });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Saved s3:\/\/bucket\/.* but could not attach metadata: NotImplemented$/
      )
    );
  });

  it('keeps the save successful and warns when the metadata copy gets a 412', async () => {
    // Forces the copy path (rather than the default tag) so this test can exercise it in
    // isolation: tagging is covered separately above.
    storage.conditionalWriteUnsupported = true;
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockReplaceObjectMetadata.mockRejectedValueOnce(
      Object.assign(new Error('At least one of the pre-conditions did not hold'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      })
    );

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"streamed"' } });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringMatching(/but could not attach metadata: At least one of the pre-conditions/)
    );
  });

  it('passes the encoded tags to the streaming upload', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('x'));
      return 0;
    });
    await saveToS3(tier({ streaming: true, tags: [{ Key: 'repo', Value: 'acme/app' }] }), 'k', [
      'node_modules',
    ]);
    const [, , , , , options] = mockCreateStreamUpload.mock.calls[0];
    expect(options).toEqual({ ifNoneMatch: '*', tagging: 'repo=acme%2Fapp' });
  });

  it('falls back to a file-mode save without tags when the streamed upload server rejects tagging', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(async () => {
        throw Object.assign(new Error('NotImplemented'), {
          name: 'NotImplemented',
          $metadata: { httpStatusCode: 501 },
        });
      }),
      abort: jest.fn(async () => undefined),
    });

    const outcome = await saveToS3(
      tier({ streaming: true, tags: [{ Key: 'a', Value: 'b' }] }),
      'k',
      ['node_modules']
    );

    expect(outcome.kind).toBe('saved');
    expect(storage.objectTaggingUnsupported).toBe(true);
    expect(storage.conditionalWriteUnsupported).toBeUndefined();
    expect(mockWarning).toHaveBeenCalledWith(
      's3://bucket could not store object tags (NotImplemented); saved without them.'
    );
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({
      metadata: { 'cloud-cache-sha256': 'archive-sha256' },
      ifNoneMatch: '*',
    });
  });

  it('falls back to a file-mode save that keeps the condition when the streamed write gets a 409', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockCreateStreamUpload.mockImplementation((_client, _bucket, _key, body) => ({
      done: jest.fn(async () => {
        for await (const _chunk of body as Readable) {
          // Drain it, as the real Upload does before sending the conditional write.
        }
        throw conditionalConflict();
      }),
      abort: jest.fn(async () => undefined),
    }));

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"new"' } });
    expect(storage.conditionalWriteUnsupported).toBeUndefined();
    expect(mockCreateArchive).toHaveBeenCalledTimes(1);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const [, , , , , options] = mockUploadFile.mock.calls[0];
    expect(options).toEqual({
      metadata: { 'cloud-cache-sha256': 'archive-sha256' },
      ifNoneMatch: '*',
    });
  });

  it('does not retry again when the file-mode fallback after a streamed 409 conflicts too', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    mockCreateStreamUpload.mockImplementation((_client, _bucket, _key, body) => ({
      done: jest.fn(async () => {
        for await (const _chunk of body as Readable) {
          // Drain it.
        }
        throw conditionalConflict();
      }),
      abort: jest.fn(async () => undefined),
    }));
    mockUploadFile.mockRejectedValue(conditionalConflict());

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

    expect(outcome.kind).toBe('error');
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
  });

  it("includes tar's stderr tail in the error and kills tar when tar exits non-zero", async () => {
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end();
      return 2;
    });
    mockCaptureStderrTail.mockReturnValue({
      lines: () => ['tar: short write', 'tar: error exit delayed from previous errors'],
    });
    // Stands in for lib-storage: done() stays pending until abort() is called, then rejects.
    let rejectDone: (err: Error) => void = () => undefined;
    const abort = jest.fn(async () => rejectDone(new Error('Upload aborted.')));
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(
        () =>
          new Promise<{ ETag?: string }>((_resolve, reject) => {
            rejectDone = reject;
          })
      ),
      abort,
    });

    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('tar exited with code 2');
    expect(message).toContain('tar: short write');
    expect(message).toContain('tar: error exit delayed from previous errors');
    expect(abort).toHaveBeenCalled();
    expect(mockKillIfRunning).toHaveBeenCalledWith(child);
  });

  it('falls back to file mode when BSD tar and zstd on Windows would be needed', async () => {
    mockUsesSeparateZstd.mockReturnValue(true);
    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
    expect(mockCreateArchive).toHaveBeenCalled();
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.'
    );
    expect(mockUsesSeparateZstd).toHaveBeenCalledWith({
      tar: { path: '/usr/bin/tar', flavor: 'gnu' },
      platform: process.platform,
      compression: 'zstd',
    });
  });

  it('leaves no unhandled rejection when something throws synchronously right after spawning tar', async () => {
    const onUnhandledRejection = jest.fn();
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      let child: FakeChild | undefined;
      mockSpawnArchiveCommand.mockImplementation(() => {
        child = makeFakeChild();
        return child;
      });
      // tar itself would exit fine, but nothing ever awaits that outcome on this path: the
      // throw below happens before createStreamUpload's caller ever reaches the inner try.
      mockWaitForExit.mockImplementation(async (c) => {
        c.stdout.end(Buffer.from('x'));
        return 2;
      });
      mockCreateStreamUpload.mockImplementation(() => {
        throw new Error('invalid upload configuration');
      });

      const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);

      expect(outcome.kind).toBe('error');
      const message = outcome.kind === 'error' ? outcome.error.message : '';
      expect(message).toContain('invalid upload configuration');
      expect(mockKillIfRunning).toHaveBeenCalledWith(child);

      // Give the orphaned `finalized` promise (driven by tar's mocked non-zero exit) a chance
      // to actually settle and, if unhandled, surface as an 'unhandledRejection' event before
      // asserting that it did not.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('attaches the checksum with a tag instead of copying the object', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    const outcome = await saveToS3(
      tier({ streaming: true, tags: [{ Key: 'team', Value: 'platform' }] }),
      'k',
      ['node_modules']
    );
    expect(outcome.kind).toBe('saved');
    expect(mockReplaceObjectMetadata).not.toHaveBeenCalled();
    const [, bucket, key, tags] = mockPutObjectTags.mock.calls[0];
    expect(bucket).toBe('bucket');
    expect(key).toContain('cache.tar.zst');
    expect(tags).toEqual([
      { Key: 'team', Value: 'platform' },
      { Key: 'cloud-cache-sha256', Value: expect.any(String) as unknown as string },
    ]);
  });

  it('copies instead of tagging when user metadata is configured', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    await saveToS3(tier({ streaming: true, metadata: { team: 'platform' } }), 'k', [
      'node_modules',
    ]);
    expect(mockPutObjectTags).not.toHaveBeenCalled();
    expect(mockReplaceObjectMetadata).toHaveBeenCalled();
  });

  it('copies instead of tagging when the tier cannot use the conditional create', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    const t = tier({ streaming: true });
    t.storage.conditionalWriteUnsupported = true;
    await saveToS3(t, 'k', ['node_modules']);
    expect(mockPutObjectTags).not.toHaveBeenCalled();
    expect(mockReplaceObjectMetadata).toHaveBeenCalled();
  });

  it('falls back to the copy, and remembers, when the server has no tagging API', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    const t = tier({ streaming: true });
    mockPutObjectTags.mockRejectedValueOnce(
      Object.assign(new Error('NotImplemented'), {
        name: 'NotImplemented',
        $metadata: { httpStatusCode: 501 },
      })
    );
    await saveToS3(t, 'k', ['node_modules']);
    expect(mockReplaceObjectMetadata).toHaveBeenCalled();
    expect(t.storage.objectTaggingUnsupported).toBe(true);
  });

  it('still succeeds, with a warning, when neither the tag nor the copy can be attached', async () => {
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (c) => {
      c.stdout.end(Buffer.from('archive-body'));
      return 0;
    });
    // A generic failure whose message happens to mention "tagging" (an AccessDenied on
    // s3:PutObjectTagging, say) must not be read as "the server has no tagging API": that would
    // silently drop the user's own tags from every later upload in the run.
    const t = tier({ streaming: true });
    mockPutObjectTags.mockRejectedValue(new Error('tagging blocked'));
    mockReplaceObjectMetadata.mockRejectedValue(new Error('copy blocked'));
    const outcome = await saveToS3(t, 'k', ['node_modules']);
    expect(outcome.kind).toBe('saved');
    expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('could not attach metadata'));
    expect(t.storage.objectTaggingUnsupported).toBeFalsy();
  });
});

/**
 * A fake tar closer to a real ChildProcess than makeFakeChild: its close (what waitForExit
 * waits for) only happens once it has been killed AND its stdout stream has closed, exactly
 * like Node's 'close' event, which waits for the stdio streams. Paired with the real, bounded
 * waitForExitAfterKill (5 s), so a failure path that waits on something that can never settle
 * shows up as elapsed time instead of hanging the test.
 */
function useRealisticTar(): { child: () => FakeChild | undefined } {
  let child: FakeChild | undefined;
  let killed = false;
  let onKill: () => void = () => undefined;
  mockSpawnArchiveCommand.mockImplementation(() => {
    child = makeFakeChild();
    child.kill = jest.fn(() => {
      killed = true;
      onKill();
    });
    return child;
  });
  mockWaitForExit.mockImplementation(
    (c) =>
      new Promise<number>((_resolve, reject) => {
        let stdoutClosed = false;
        const settle = () => {
          if (killed && stdoutClosed) {
            reject(new Error('tar was terminated by signal SIGTERM'));
          }
        };
        onKill = settle;
        c.stdout.on('close', () => {
          stdoutClosed = true;
          settle();
        });
      })
  );
  mockKillIfRunning.mockImplementation((c) => {
    if (!killed) {
      c.kill();
    }
  });
  mockWaitForExitAfterKill.mockImplementation(async (c, settle) => {
    mockKillIfRunning(c);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settle.then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  return { child: () => child };
}

describe('saveToS3 streaming failure timing', () => {
  it('settles quickly when the upload stops reading the body and then rejects', async () => {
    const tar = useRealisticTar();
    const waitForClose = mockWaitForExit.getMockImplementation() as (
      c: FakeChild
    ) => Promise<number>;
    mockWaitForExit.mockImplementationOnce((c) => {
      // More than the pipe's buffers hold, so tar's stdout is left paused with data buffered.
      c.stdout.write(Buffer.alloc(1024 * 1024, 't'));
      return waitForClose(c);
    });
    mockCreateStreamUpload.mockReturnValue({
      done: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      }),
      abort: jest.fn(async () => undefined),
    });

    const started = Date.now();
    const outcome = await saveToS3(tier({ streaming: true }), 'k', ['node_modules']);
    const elapsed = Date.now() - started;

    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' ? outcome.error.message : '').toContain('Access Denied');
    expect(tar.child()?.kill).toHaveBeenCalled();
    expect(elapsed).toBeLessThan(2000);
  }, 20_000);
});

describe('restoreFromS3 parallel download', () => {
  const MiB = 1024 * 1024;
  // 20 MiB + 1 byte: three 8 MiB parts, so the object is larger than one part.
  const large = (): string => {
    const objectKey = put(FEATURE, 'k', 1);
    objects.set(objectKey, {
      ...(objects.get(objectKey) as { size: number; lastModified: Date; etag: string }),
      size: 20 * MiB + 1,
    });
    return objectKey;
  };

  it('downloads a large object in ranged parts, with the tier settings and stream retries', async () => {
    const objectKey = large();
    mockDownloadFileInParts.mockResolvedValue({
      metadata: { 'cloud-cache-sha256': 'good-hash' },
      parts: 3,
    });
    mockSha256File.mockResolvedValue('good-hash');
    const outcome = await restoreFromS3(tier({ streamRetries: 2 }), 'k', [], false);
    expect(outcome).toMatchObject({ kind: 'hit', matchedKey: 'k', downloadParts: 3 });
    const [, bucket, key, target, options] = mockDownloadFileInParts.mock.calls[0];
    expect([bucket, key, path.basename(target)]).toEqual(['bucket', objectKey, 'cache.tar.zst']);
    expect(options).toEqual({ size: 20 * MiB + 1, partSize: 8 * MiB, concurrency: 8, retries: 2 });
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockExtractArchive).toHaveBeenCalledWith(target, zstd, '/ws');
    expect(mockInfo).toHaveBeenCalledWith(
      'Downloading 20.00 MB in 3 parts of 8.00 MB, 3 at a time'
    );
  });

  it('uses one request, and reports one part, for an object no larger than a part', async () => {
    put(FEATURE, 'k', 1);
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome).toMatchObject({ kind: 'hit', downloadParts: 1 });
    expect(mockDownloadFileInParts).not.toHaveBeenCalled();
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    expect(mockInfo).not.toHaveBeenCalledWith(expect.stringContaining('parts of'));
  });

  it('uses one request when download-concurrency is 1', async () => {
    large();
    const outcome = await restoreFromS3(
      tier({ download: { concurrency: 1, partSize: 8 * MiB } }),
      'k',
      [],
      false
    );
    expect(outcome).toMatchObject({ kind: 'hit', downloadParts: 1 });
    expect(mockDownloadFileInParts).not.toHaveBeenCalled();
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
  });

  it('falls back to one request, with an info line, when the server ignores Range', async () => {
    const objectKey = large();
    mockDownloadFileInParts.mockRejectedValue(new RangeNotSupportedError('bucket', objectKey));
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome).toMatchObject({ kind: 'hit', downloadParts: 1 });
    expect(mockDownloadFile).toHaveBeenCalledTimes(1);
    expect(mockInfo).toHaveBeenCalledWith(
      `s3://bucket/${objectKey} does not support ranged GET requests; downloading it in one request.`
    );
    expect(mockExtractArchive).toHaveBeenCalled();
  });

  it('returns any other part failure as an error, without a single-request retry', async () => {
    large();
    mockDownloadFileInParts.mockRejectedValue(new Error('Access Denied'));
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toBe('Access Denied');
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockExtractArchive).not.toHaveBeenCalled();
  });

  it('verifies the sha256 of an archive assembled from parts', async () => {
    large();
    mockDownloadFileInParts.mockResolvedValue({
      metadata: { 'cloud-cache-sha256': 'expected-hash' },
      parts: 3,
    });
    mockSha256File.mockResolvedValue('actual-hash');
    const outcome = await restoreFromS3(tier(), 'k', [], false);
    expect(outcome.kind === 'error' && outcome.error.message).toContain('Integrity check failed');
    expect(mockExtractArchive).not.toHaveBeenCalled();
  });

  describe('streaming', () => {
    let workspace: string;
    beforeEach(() => {
      workspace = makeTempDir('parallel-stream-restore-ws');
      mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
      mockWaitForExit.mockResolvedValue(0);
    });
    afterEach(() => removeDir(workspace));

    it('pipes the ordered parts stream into tar and reports the part count', async () => {
      const objectKey = large();
      const payload = Buffer.from('archive-payload');
      mockOpenObjectPartsStream.mockResolvedValue({
        body: Readable.from([payload]),
        metadata: {
          'cloud-cache-sha256': crypto.createHash('sha256').update(payload).digest('hex'),
        },
        parts: 3,
      });
      const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
      expect(outcome).toMatchObject({ kind: 'hit', downloadParts: 3 });
      const [, bucket, key, options] = mockOpenObjectPartsStream.mock.calls[0];
      expect([bucket, key]).toEqual(['bucket', objectKey]);
      expect(options).toEqual({
        size: 20 * MiB + 1,
        partSize: 8 * MiB,
        concurrency: 8,
        retries: 0,
      });
      expect(mockGetObjectStream).not.toHaveBeenCalled();
    });

    it('falls back to a single GetObject stream when the server ignores Range', async () => {
      const objectKey = large();
      mockOpenObjectPartsStream.mockRejectedValue(new RangeNotSupportedError('bucket', objectKey));
      mockGetObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('data')]) });
      const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
      expect(outcome).toMatchObject({ kind: 'hit', downloadParts: 1 });
      expect(mockGetObjectStream).toHaveBeenCalledTimes(1);
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('does not support ranged GET'));
    });

    it('returns an error, without spawning tar, when the parts stream cannot be opened', async () => {
      large();
      mockOpenObjectPartsStream.mockRejectedValue(new Error('Access Denied'));
      const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
      expect(outcome.kind === 'error' && outcome.error.message).toBe('Access Denied');
      expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
      expect(mockGetObjectStream).not.toHaveBeenCalled();
    });
  });
});

describe('restoreFromS3 streaming', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempDir('stream-restore-ws');
  });

  afterEach(() => removeDir(workspace));

  it('streams the download straight into a piped tar extract and verifies its sha256', async () => {
    put(FEATURE, 'k', 1);
    const payload = Buffer.from('archive-payload');
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
    mockGetObjectStream.mockResolvedValue({
      body: Readable.from([payload]),
      metadata: { 'cloud-cache-sha256': expectedSha256 },
    });
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);

    expect(outcome).toMatchObject({
      kind: 'hit',
      matchedKey: 'k',
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(mockDownloadFile).not.toHaveBeenCalled();
    expect(mockExtractArchive).not.toHaveBeenCalled();
    expect(mockSha256File).not.toHaveBeenCalled();

    const [command, stdio] = mockSpawnArchiveCommand.mock.calls[0];
    expect(command.tool).toBe('/usr/bin/tar');
    expect(stdio).toEqual(['pipe', 'ignore', 'pipe']);
    const [plan] = mockBuildExtractCommands.mock.calls[0];
    expect(plan).toMatchObject({ archivePath: '-', workspace, compression: 'zstd' });
    expect(fs.existsSync(workspace)).toBe(true);
  });

  it('returns an integrity error, noting files may already be extracted, on a sha256 mismatch', async () => {
    const objectKey = put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({
      body: Readable.from([Buffer.from('archive-payload')]),
      metadata: { 'cloud-cache-sha256': 'expected-hash' },
    });
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain(`Integrity check failed for s3://bucket/${objectKey}`);
    expect(message).toContain('expected sha256 expected-hash');
    expect(message).toContain('files may already have been extracted');
  });

  it('skips verification when the object carries no checksum metadata', async () => {
    put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('data')]) });
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockResolvedValue(0);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('hit');
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('sha256'));
  });

  it('kills tar and returns an error, with its stderr tail, when tar fails', async () => {
    put(FEATURE, 'k', 1);
    mockGetObjectStream.mockResolvedValue({ body: Readable.from([Buffer.from('data')]) });
    let child: FakeChild | undefined;
    mockSpawnArchiveCommand.mockImplementation(() => {
      child = makeFakeChild();
      return child;
    });
    mockWaitForExit.mockResolvedValue(2);
    mockCaptureStderrTail.mockReturnValue({ lines: () => ['tar: corrupt input'] });

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('error');
    const message = outcome.kind === 'error' ? outcome.error.message : '';
    expect(message).toContain('tar exited with code 2');
    expect(message).toContain('tar: corrupt input');
    expect(mockKillIfRunning).toHaveBeenCalledWith(child);
  });

  it('falls back to file mode when BSD tar and zstd on Windows would be needed', async () => {
    put(FEATURE, 'k', 1);
    mockUsesSeparateZstd.mockReturnValue(true);

    const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);
    expect(outcome.kind).toBe('hit');
    expect(mockDownloadFile).toHaveBeenCalled();
    expect(mockSpawnArchiveCommand).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.'
    );
    expect(mockUsesSeparateZstd).toHaveBeenCalledWith({
      tar: { path: '/usr/bin/tar', flavor: 'gnu' },
      platform: process.platform,
      compression: 'zstd',
    });
  });

  it('leaves no unhandled rejection, and releases the body, when the pipeline never starts', async () => {
    const onUnhandledRejection = jest.fn();
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      put(FEATURE, 'k', 1);
      const body = new PassThrough();
      mockGetObjectStream.mockResolvedValue({ body });
      let child: FakeChild | undefined;
      mockSpawnArchiveCommand.mockImplementation(() => {
        child = makeFakeChild();
        return child;
      });
      // tar is killed and its wait rejects (terminated by a signal) after the failure below.
      mockWaitForExit.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('tar was terminated by signal SIGTERM');
      });
      mockCreateSha256Tap.mockImplementationOnce(() => {
        throw new Error('hash unavailable');
      });

      const outcome = await restoreFromS3(tier({ streaming: true, workspace }), 'k', [], false);

      expect(outcome.kind).toBe('error');
      expect(outcome.kind === 'error' ? outcome.error.message : '').toContain('hash unavailable');
      expect(mockKillIfRunning).toHaveBeenCalledWith(child);
      expect(body.destroyed).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('listCandidates', () => {
  it('returns every object under the prefix with its key, version and acceptance', async () => {
    put(FEATURE, 'k-one', 1);
    put(FEATURE, 'k-two', 2, 'other-version');
    put(MAIN, 'k-three', 3);
    objects.set(`octo/app/${encodeURIComponent(FEATURE)}/k-four/notes.txt`, {
      size: 1,
      lastModified: new Date(),
      etag: '"x"',
    });

    const candidates = await listCandidates(tier(), FEATURE, 'k-');

    expect(candidates).toEqual([
      expect.objectContaining({ objectKey: expect.stringContaining('notes.txt'), accepted: false }),
      expect.objectContaining({ key: 'k-one', version: VERSION, accepted: true, size: 101 }),
      expect.objectContaining({ key: undefined, version: 'other-version', accepted: false }),
    ]);
    expect(mockListObjects).toHaveBeenCalledWith(
      storage.client,
      storage.bucket,
      `octo/app/${encodeURIComponent(FEATURE)}/k-`
    );
  });
});

describe('buildExplainReport against findS3Match', () => {
  const explainConfig = {
    primaryKey: 'npm-linux',
    restoreKeys: ['npm-'],
    paths: ['~/.npm'],
    enableCrossOsArchive: false,
    dualCache: false,
    useFallback: false,
    restorePriority: 's3-first' as const,
  };

  const shapes: Array<[string, () => void]> = [
    ['an empty bucket', () => undefined],
    [
      'the exact key next to a newer sibling under the same prefix',
      () => {
        put(FEATURE, 'npm-linux', 1);
        put(FEATURE, 'npm-linux-v2', 9);
      },
    ],
    [
      'only a newer sibling under the primary prefix',
      () => {
        put(FEATURE, 'npm-linux-v2', 9);
        put(FEATURE, 'npm-linux-v1', 3);
      },
    ],
    [
      'a restore-key partial match on a later ref only',
      () => {
        put(MAIN, 'npm-other', 4);
      },
    ],
    [
      'objects of another version only',
      () => {
        put(FEATURE, 'npm-linux', 1, 'other-version');
        put(MAIN, 'npm-linux', 2, 'other-version');
      },
    ],
    [
      'a hit on the current ref that shadows a newer object on the base ref',
      () => {
        put(FEATURE, 'npm-old', 1);
        put(MAIN, 'npm-linux', 9);
      },
    ],
  ];

  it.each(shapes)('agrees with findS3Match for %s', async (_name, fill) => {
    fill();

    const match = await findS3Match(tier(), explainConfig.primaryKey, explainConfig.restoreKeys);
    const report = await buildExplainReport(tier(), explainConfig);

    if (match === undefined) {
      expect(report.wouldHit).toBeUndefined();
      return;
    }
    expect(report.wouldHit).toEqual({
      objectKey: match.objectKey,
      matchedKey: match.matchedKey,
      exact: match.exact,
      ref: match.ref || null,
    });
  });
});
