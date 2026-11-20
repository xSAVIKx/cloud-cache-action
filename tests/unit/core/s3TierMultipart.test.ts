/**
 * Drives saveToS3 through the REAL storage operations (lib-storage Upload) against
 * aws-sdk-client-mock, with bodies larger than one part, so the multipart contract is asserted
 * on the commands actually sent: a CompleteMultipartUpload that fails must leave no orphaned
 * multipart upload behind (an AbortMultipartUploadCommand with its UploadId), in file mode, in
 * streaming, and on the unsupported-condition fallback.
 */
import { jest } from '@jest/globals';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import type { CompressionConfig } from '../../../src/archive/compression';
import type { ArchiveCommand, TarTool } from '../../../src/archive/tar';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import type { StorageContext } from '../../../src/storage/client';

const PART = 5 * 1024 * 1024;
const ARCHIVE_SIZE = 12 * 1024 * 1024;

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: () => void;
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

jest.unstable_mockModule('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));
jest.unstable_mockModule('../../../src/archive/paths', () => ({
  resolveCachePaths: async () => ({ entries: ['node_modules'], skipped: [] }),
  getWorkspace: () => '/ws',
}));
jest.unstable_mockModule('../../../src/archive/tar', () => ({
  createArchive: async (archivePath: string) => {
    const archive = Buffer.alloc(ARCHIVE_SIZE, 'a');
    fs.writeFileSync(archivePath, archive);
    return { sha256: createHash('sha256').update(archive).digest('hex') };
  },
  extractArchive: async () => undefined,
  getArchiveSize: (archivePath: string) => fs.statSync(archivePath).size,
  findTar: async (): Promise<TarTool> => ({ path: '/usr/bin/tar', flavor: 'gnu' }),
  usesSeparateZstd: () => false,
  buildCreateCommands: () => [{ tool: '/usr/bin/tar', args: ['-cf', '-'] }],
  buildExtractCommands: () => [{ tool: '/usr/bin/tar', args: ['-xf', '-'] }],
  formatManifest: (entries: readonly string[]) => `${entries.join('\n')}\n`,
}));
jest.unstable_mockModule('../../../src/archive/stream', () => ({
  spawnArchiveCommand: mockSpawnArchiveCommand,
  waitForExit: mockWaitForExit,
  killIfRunning: mockKillIfRunning,
  waitForExitAfterKill: async (child: FakeChild, settle: Promise<unknown>) => {
    mockKillIfRunning(child);
    await settle.then(
      () => undefined,
      () => undefined
    );
  },
  captureStderrTail: () => ({ lines: () => [] }),
  createByteCounter: () => {
    let total = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        callback(null, chunk);
      },
    });
    return { stream, count: () => total };
  },
}));

const { saveToS3 } = await import('../../../src/core/s3Tier');
type S3Tier = Parameters<typeof saveToS3>[0];

const s3Mock = mockClient(S3Client);
const zstd: CompressionConfig = { method: 'zstd', archiveFilename: 'cache.tar.zst' };

let storage: StorageContext;
const tier = (streaming: boolean): S3Tier => ({
  storage,
  template: compileKeyTemplate({
    pattern: '${key}/${version}/${archive_filename}',
    repository: '',
    prefix: '',
    scopedToRepository: false,
    scopedToRef: false,
    version: 'v',
    archiveFilename: zstd.archiveFilename,
    env: {},
  }),
  restoreRefs: [''],
  saveRef: '',
  compression: zstd,
  workspace: '/ws',
  streamRetries: 0,
  streaming,
  download: { concurrency: 8, partSize: 8 * 1024 * 1024 },
  upload: { concurrency: 8, partSize: PART },
  metadata: {},
  tags: [],
});
const OBJECT_KEY = 'k/v/cache.tar.zst';

const preconditionFailed = () =>
  Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });
const notImplemented = () =>
  Object.assign(new Error('Not Implemented'), {
    name: 'NotImplemented',
    $metadata: { httpStatusCode: 501 },
  });

/** Every UploadId aborted so far, in order. lib-storage and completeOrAbort can both abort one upload. */
const abortedUploadIds = (): Array<string | undefined> =>
  s3Mock.commandCalls(AbortMultipartUploadCommand).map((call) => {
    expect(call.args[0].input).toMatchObject({ Bucket: 'bucket', Key: OBJECT_KEY });
    return call.args[0].input.UploadId;
  });

/** A tar that writes `size` bytes to stdout, then closes with `code`. */
const tarWriting = (size: number, code: number): void => {
  mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
  mockWaitForExit.mockImplementation(async (child) => {
    child.stdout.end(Buffer.alloc(size, 's'));
    return code;
  });
};

beforeEach(() => {
  s3Mock.reset();
  jest.clearAllMocks();
  storage = {
    client: new S3Client({ region: 'us-east-1' }),
    bucket: 'bucket',
    providerConfig: { provider: 'aws', region: 'us-east-1', forcePathStyle: false },
  } as StorageContext;
  s3Mock.on(HeadObjectCommand).rejects(Object.assign(new Error('NotFound'), { name: 'NotFound' }));
  let uploads = 0;
  s3Mock
    .on(CreateMultipartUploadCommand)
    .callsFake(async () => ({ UploadId: `upload-${++uploads}` }));
  s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
  s3Mock.on(AbortMultipartUploadCommand).resolves({});
});

describe('saveToS3 multipart uploads that fail to complete', () => {
  it('file mode: aborts the multipart upload when Complete gets a 412, and still reports exists', async () => {
    s3Mock.on(CompleteMultipartUploadCommand).rejects(preconditionFailed());

    const outcome = await saveToS3(tier(false), 'k', ['node_modules']);

    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey: OBJECT_KEY, size: ARCHIVE_SIZE, etag: undefined },
      transferMs: expect.any(Number) as unknown as number,
      archiveMs: expect.any(Number) as unknown as number,
    });
    expect(s3Mock.commandCalls(UploadPartCommand).length).toBeGreaterThan(1);
    expect(new Set(abortedUploadIds())).toEqual(new Set(['upload-1']));
  });

  it('file mode: aborts the first multipart upload when Complete gets a 501, then saves without the condition', async () => {
    s3Mock
      .on(CompleteMultipartUploadCommand)
      .rejectsOnce(notImplemented())
      .resolves({ ETag: '"fallback"' });

    const outcome = await saveToS3(tier(false), 'k', ['node_modules']);

    expect(outcome).toEqual({
      kind: 'saved',
      s3: { objectKey: OBJECT_KEY, size: ARCHIVE_SIZE, etag: '"fallback"' },
      transferMs: expect.any(Number) as unknown as number,
      archiveMs: expect.any(Number) as unknown as number,
    });
    expect(new Set(abortedUploadIds())).toEqual(new Set(['upload-1']));
    const completes = s3Mock.commandCalls(CompleteMultipartUploadCommand);
    expect(completes.map((call) => call.args[0].input.IfNoneMatch)).toEqual(['*', undefined]);
  });

  it('streaming: aborts the multipart upload when Complete gets a 412, and still reports exists', async () => {
    tarWriting(ARCHIVE_SIZE, 0);
    s3Mock.on(CompleteMultipartUploadCommand).rejects(preconditionFailed());

    const outcome = await saveToS3(tier(true), 'k', ['node_modules']);

    expect(outcome).toEqual({
      kind: 'exists',
      s3: { objectKey: OBJECT_KEY, size: ARCHIVE_SIZE, etag: undefined },
      transferMs: expect.any(Number) as unknown as number,
    });
    expect(new Set(abortedUploadIds())).toEqual(new Set(['upload-1']));
  });

  it('streaming: aborts the streamed multipart upload when Complete gets a 501, then falls back to file mode', async () => {
    tarWriting(ARCHIVE_SIZE, 0);
    s3Mock
      .on(CompleteMultipartUploadCommand)
      .rejectsOnce(notImplemented())
      .resolves({ ETag: '"fallback"' });

    const outcome = await saveToS3(tier(true), 'k', ['node_modules']);

    expect(outcome).toMatchObject({ kind: 'saved', s3: { etag: '"fallback"' } });
    expect(new Set(abortedUploadIds())).toEqual(new Set(['upload-1']));
    expect(storage.conditionalWriteUnsupported).toBe(true);
  });

  it('streaming: aborts the multipart upload and kills tar when tar exits non-zero', async () => {
    // tar fails only after the first part has been uploaded, so a multipart upload exists.
    let partSent: () => void = () => undefined;
    const partUploaded = new Promise<void>((resolve) => {
      partSent = resolve;
    });
    s3Mock.on(UploadPartCommand).callsFake(async () => {
      partSent();
      return { ETag: '"part"' };
    });
    mockSpawnArchiveCommand.mockImplementation(() => makeFakeChild());
    mockWaitForExit.mockImplementation(async (child) => {
      child.stdout.write(Buffer.alloc(PART + 1024 * 1024, 's'));
      await partUploaded;
      child.stdout.end();
      return 2;
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"must-not-complete"' });

    const outcome = await saveToS3(tier(true), 'k', ['node_modules']);

    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' ? outcome.error.message : '').toContain(
      'tar exited with code 2'
    );
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
    expect(abortedUploadIds()).toContain('upload-1');
    expect(mockKillIfRunning).toHaveBeenCalled();
  });

  it('streaming: aborts the multipart upload and kills tar when an upload part fails', async () => {
    tarWriting(ARCHIVE_SIZE, 0);
    s3Mock
      .on(UploadPartCommand)
      .rejects(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }));

    const outcome = await saveToS3(tier(true), 'k', ['node_modules']);

    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' ? outcome.error.message : '').toContain('Access Denied');
    expect(s3Mock.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0);
    expect(abortedUploadIds()).toContain('upload-1');
    expect(mockKillIfRunning).toHaveBeenCalled();
  });
});
