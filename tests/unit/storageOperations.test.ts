import { mockClient } from 'aws-sdk-client-mock';
import {
  S3Client,
  HeadObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import {
  checkObjectExists,
  downloadFile,
  findNewestObject,
  listObjects,
  replaceObjectMetadata,
} from '../../src/storage/operations';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);
/** 5 MiB parts, so a 12 MiB fixture goes through the multipart path. */
const MULTIPART = { partSize: 5 * 1024 * 1024 };

describe('Storage Operations', () => {
  let client: S3Client;

  beforeEach(() => {
    s3Mock.reset();
    client = new S3Client({ region: 'us-east-1' });
  });

  describe('checkObjectExists', () => {
    it('returns metadata when object exists', () => {
      s3Mock
        .on(HeadObjectCommand, {
          Bucket: 'test-bucket',
          Key: 'existing-key',
        })
        .resolves({
          ContentLength: 1024,
          ETag: '"mock-etag"',
          LastModified: new Date('2026-01-01T00:00:00Z'),
        });

      return checkObjectExists(client, 'test-bucket', 'existing-key').then((meta) => {
        expect(meta).not.toBeNull();
        expect(meta?.size).toBe(1024);
        expect(meta?.etag).toBe('"mock-etag"');
      });
    });

    it('returns null when object is not found (404 / NotFound)', () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      s3Mock.on(HeadObjectCommand).rejects(notFoundError);

      return checkObjectExists(client, 'test-bucket', 'missing-key').then((meta) => {
        expect(meta).toBeNull();
      });
    });

    it('returns null when error name is NoSuchKey', async () => {
      const err = new Error('NoSuchKey');
      err.name = 'NoSuchKey';
      s3Mock.on(HeadObjectCommand).rejects(err);

      const meta = await checkObjectExists(client, 'test-bucket', 'missing-key');
      expect(meta).toBeNull();
    });

    it('returns null when httpStatusCode is 404', async () => {
      const err = { $metadata: { httpStatusCode: 404 } };
      s3Mock.on(HeadObjectCommand).rejects(err);

      const meta = await checkObjectExists(client, 'test-bucket', 'missing-key');
      expect(meta).toBeNull();
    });

    it('re-throws non-404 error', async () => {
      const err = new Error('AccessDenied');
      s3Mock.on(HeadObjectCommand).rejects(err);

      await expect(checkObjectExists(client, 'test-bucket', 'key')).rejects.toThrow('AccessDenied');
    });
  });

  describe('listObjects', () => {
    const object = (key: string | undefined, minute: number) => ({
      Key: key,
      Size: 10 + minute,
      ETag: `"${minute}"`,
      LastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
    });

    it('returns every object across pages, in server order, skipping keyless entries', async () => {
      const pages: Record<string, object> = {
        start: {
          Contents: [object('p/b', 5), object(undefined, 6), object('p/a', 1)],
          IsTruncated: true,
          NextContinuationToken: 't1',
        },
        t1: { Contents: [object('p/c', 30)], IsTruncated: false },
      };
      s3Mock
        .on(ListObjectsV2Command)
        .callsFake(
          (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
        );

      const objects = await listObjects(client, 'bucket', 'p/');

      expect(objects).toEqual([
        { key: 'p/b', size: 15, etag: '"5"', lastModified: new Date(Date.UTC(2026, 8, 13, 10, 5)) },
        { key: 'p/a', size: 11, etag: '"1"', lastModified: new Date(Date.UTC(2026, 8, 13, 10, 1)) },
        {
          key: 'p/c',
          size: 40,
          etag: '"30"',
          lastModified: new Date(Date.UTC(2026, 8, 13, 10, 30)),
        },
      ]);
      const calls = s3Mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
      expect(calls.map((input) => input.ContinuationToken)).toEqual([undefined, 't1']);
      expect(calls[0]).toMatchObject({ Bucket: 'bucket', Prefix: 'p/', MaxKeys: 1000 });
    });

    it('returns an empty list for an empty listing', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({});
      await expect(listObjects(client, 'bucket', 'p/')).resolves.toEqual([]);
    });
  });

  describe('findNewestObject', () => {
    const object = (key: string, minute: number) => ({
      Key: key,
      Size: 10 + minute,
      ETag: `"${minute}"`,
      LastModified: new Date(Date.UTC(2026, 8, 13, 10, minute)),
    });
    const pages: Record<string, object> = {
      start: {
        Contents: [object('p/a/cache.tar.zst', 1), object('p/b/cache.tar.zst', 5)],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      t1: {
        Contents: [object('p/c/cache.tar.gz', 30)],
        IsTruncated: true,
        NextContinuationToken: 't2',
      },
      t2: { Contents: [object('p/d/cache.tar.zst', 20)], IsTruncated: false },
    };

    it('follows continuation tokens and returns the newest accepted object', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .callsFake(
          (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
        );

      const newest = await findNewestObject(client, 'bucket', 'p/', (key) => key.endsWith('.zst'));

      expect(newest).toEqual({
        key: 'p/d/cache.tar.zst',
        size: 30,
        etag: '"20"',
        lastModified: new Date(Date.UTC(2026, 8, 13, 10, 20)),
      });
      const calls = s3Mock.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input);
      expect(calls.map((input) => input.ContinuationToken)).toEqual([undefined, 't1', 't2']);
      expect(calls[0]).toMatchObject({ Bucket: 'bucket', Prefix: 'p/', MaxKeys: 1000 });
    });

    it('returns undefined when no object is accepted', async () => {
      s3Mock
        .on(ListObjectsV2Command)
        .callsFake(
          (input: { ContinuationToken?: string }) => pages[input.ContinuationToken ?? 'start']
        );
      await expect(findNewestObject(client, 'bucket', 'p/', () => false)).resolves.toBeUndefined();
    });

    it('keeps the first object listed when timestamps tie', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [object('p/x/cache.tar.zst', 7), object('p/y/cache.tar.zst', 7)],
        IsTruncated: false,
      });
      expect((await findNewestObject(client, 'bucket', 'p/', () => true))?.key).toBe(
        'p/x/cache.tar.zst'
      );
    });

    it('handles an empty listing', async () => {
      s3Mock.on(ListObjectsV2Command).resolves({});
      await expect(findNewestObject(client, 'bucket', 'p/', () => true)).resolves.toBeUndefined();
    });
  });

  describe('downloadFile', () => {
    it('pipes S3 GetObject stream to local destination path', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'subfolder', 'downloaded.txt');

      const mockStream = new Readable();
      mockStream.push('hello-cache-content');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
      });

      await downloadFile(client, 'test-bucket', 'sample-key', destPath);

      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf8')).toBe('hello-cache-content');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('throws error when response Body is empty', async () => {
      s3Mock.on(GetObjectCommand).resolves({});
      const tempPath = path.join(os.tmpdir(), 'empty-body-test.txt');

      await expect(downloadFile(client, 'test-bucket', 'empty-key', tempPath)).rejects.toThrow(
        'Empty response body received'
      );
    });

    it('returns the object metadata from the GetObject response', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'with-metadata.txt');
      const mockStream = new Readable();
      mockStream.push('data');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
        Metadata: { 'cloud-cache-sha256': 'abc123' },
      });

      const result = await downloadFile(client, 'test-bucket', 'sample-key', destPath);
      expect(result.metadata).toEqual({ 'cloud-cache-sha256': 'abc123' });

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('leaves metadata undefined when the response carries none', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      const destPath = path.join(tempDir, 'no-metadata.txt');
      const mockStream = new Readable();
      mockStream.push('data');
      mockStream.push(null);

      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
      });

      const result = await downloadFile(client, 'test-bucket', 'sample-key', destPath);
      expect(result.metadata).toBeUndefined();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('uploadFile', () => {
    it('uploads file via lib-storage Upload and returns size and etag', async () => {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'file-to-upload.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(1024, 'a'));

      s3Mock.on(PutObjectCommand).resolves({
        ETag: '"mocked-etag"',
      });

      const res = await uploadFile(client, 'test-bucket', 'uploaded-key', sampleFile, {
        partSize: 10 * 1024 * 1024,
      });

      expect(res.size).toBe(1024);
      expect(res.etag).toBe('"mocked-etag"');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it.each([
      ['at exactly 5 MiB, the S3 minimum, as 5 MiB parts', 5 * 1024 * 1024, 3],
      ['at 6 MiB as 6 MiB parts', 6 * 1024 * 1024, 2],
      ['just under 5 MiB as one 64 MiB part', 5 * 1024 * 1024 - 1, 0],
      ['unset as one 64 MiB part', undefined, 0],
    ])('uploads 12 MiB with the part size %s', async (_label, partSize, parts) => {
      const {
        CompleteMultipartUploadCommand,
        CreateMultipartUploadCommand,
        PutObjectCommand,
        UploadPartCommand,
      } = await import('@aws-sdk/client-s3');
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"single"' });
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-key', sampleFile, { partSize });
        expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(parts);
        expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(parts === 0 ? 1 : 0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // lib-storage holds the final part back until the stream ends, so three parts never show
    // more than two in flight; the cap, not the ceiling, is what these pin. Each part blocks
    // until the expected peak is reached rather than for a fixed time, so a runner that reads
    // the file more slowly than the parts complete cannot make this miss an overlap.
    it.each([
      [1, 1],
      [2, 2],
    ])(
      'sends at most %s parts at once, over 3 parts',
      async (concurrency, peakExpected) => {
        const { CompleteMultipartUploadCommand, CreateMultipartUploadCommand, UploadPartCommand } =
          await import('@aws-sdk/client-s3');
        const { uploadFile } = await import('../../src/storage/operations');

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
        const sampleFile = path.join(tempDir, 'large.bin');
        fs.writeFileSync(sampleFile, Buffer.alloc(15 * 1024 * 1024, 'a'));
        let inFlight = 0;
        let peak = 0;
        let releasePeakReached: () => void = () => undefined;
        const peakReached = new Promise<void>((resolve) => {
          releasePeakReached = resolve;
        });
        s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
        s3Mock.on(UploadPartCommand).callsFake(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          if (peak >= peakExpected) {
            releasePeakReached();
          }
          // The safety valve only matters when the cap is never reached, which is the failure this
          // test is meant to report: it ends the wait so the assertion below runs instead of hanging.
          await Promise.race([peakReached, new Promise((resolve) => setTimeout(resolve, 10_000))]);
          inFlight -= 1;
          return { ETag: '"part"' };
        });
        s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

        try {
          await uploadFile(client, 'test-bucket', 'large-key', sampleFile, {
            partSize: 5 * 1024 * 1024,
            concurrency,
          });
          expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(3);
          expect(peak).toBe(peakExpected);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      30_000
    );

    it('passes metadata and ifNoneMatch through to a single-part PutObject', async () => {
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'small.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(1024, 'a'));
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"mocked-etag"' });

      try {
        await uploadFile(client, 'test-bucket', 'meta-key', sampleFile, MULTIPART, {
          metadata: { 'cloud-cache-sha256': 'deadbeef' },
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(PutObjectCommand);
        expect(call.args[0].input).toMatchObject({
          Metadata: { 'cloud-cache-sha256': 'deadbeef' },
          IfNoneMatch: '*',
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('passes metadata and ifNoneMatch through to a multipart upload', async () => {
      const { CompleteMultipartUploadCommand, UploadPartCommand } = await import(
        '@aws-sdk/client-s3'
      );
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large-meta.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-meta-key', sampleFile, MULTIPART, {
          metadata: { 'cloud-cache-sha256': 'feedface' },
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(CreateMultipartUploadCommand);
        expect(call.args[0].input).toMatchObject({
          Metadata: { 'cloud-cache-sha256': 'feedface' },
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('forwards Tagging and user metadata to PutObject for a single-part upload', async () => {
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const smallFile = path.join(tempDir, 'tagged-small.bin');
      fs.writeFileSync(smallFile, Buffer.alloc(1024, 'a'));
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"e"' });

      try {
        await uploadFile(client, 'b', 'k', smallFile, MULTIPART, {
          metadata: { 'cloud-cache-sha256': 'abc', team: 'x' },
          tagging: 'repo=acme%2Fapp',
        });
        const input = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
        expect(input.Tagging).toBe('repo=acme%2Fapp');
        expect(input.Metadata).toEqual({ 'cloud-cache-sha256': 'abc', team: 'x' });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('forwards Tagging and metadata to CreateMultipartUpload for a multipart upload', async () => {
      const { CompleteMultipartUploadCommand } = await import('@aws-sdk/client-s3');
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const largeFile = path.join(tempDir, 'tagged-large.bin');
      fs.writeFileSync(largeFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'b', 'k', largeFile, MULTIPART, {
          metadata: { 'cloud-cache-sha256': 'abc' },
          tagging: 'repo=acme%2Fapp',
        });
        const input = s3Mock.commandCalls(CreateMultipartUploadCommand)[0].args[0].input;
        expect(input.Tagging).toBe('repo=acme%2Fapp');
        expect(input.Metadata).toEqual({ 'cloud-cache-sha256': 'abc' });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('passes ifNoneMatch through to CompleteMultipartUploadCommand, where the condition takes effect', async () => {
      const { uploadFile } = await import('../../src/storage/operations');

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-'));
      const sampleFile = path.join(tempDir, 'large-condition.bin');
      fs.writeFileSync(sampleFile, Buffer.alloc(12 * 1024 * 1024, 'a'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      try {
        await uploadFile(client, 'test-bucket', 'large-condition-key', sampleFile, MULTIPART, {
          ifNoneMatch: '*',
        });
        const [call] = s3Mock.commandCalls(CompleteMultipartUploadCommand);
        expect(call.args[0].input).toMatchObject({ IfNoneMatch: '*' });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('aborting a multipart upload that fails to complete', () => {
    const preconditionFailed = () =>
      Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      });
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-upload-abort-'));
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const largeFile = (): string => {
      const file = path.join(tempDir, 'large.bin');
      fs.writeFileSync(file, Buffer.alloc(12 * 1024 * 1024, 'a'));
      return file;
    };

    it('uploadFile sends AbortMultipartUpload and rethrows the original error when Complete is rejected', async () => {
      const { uploadFile } = await import('../../src/storage/operations');
      const failure = preconditionFailed();
      s3Mock.on(CompleteMultipartUploadCommand).rejects(failure);
      s3Mock.on(AbortMultipartUploadCommand).resolves({});

      await expect(
        uploadFile(client, 'test-bucket', 'large-key', largeFile(), MULTIPART, { ifNoneMatch: '*' })
      ).rejects.toBe(failure);

      const aborts = s3Mock.commandCalls(AbortMultipartUploadCommand);
      expect(aborts).toHaveLength(1);
      expect(aborts[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: 'large-key',
        UploadId: 'upload-1',
      });
    });

    it('uploadFile still rethrows the original error when the abort itself fails', async () => {
      const { uploadFile } = await import('../../src/storage/operations');
      const failure = preconditionFailed();
      s3Mock.on(CompleteMultipartUploadCommand).rejects(failure);
      s3Mock.on(AbortMultipartUploadCommand).rejects(new Error('abort failed'));

      await expect(
        uploadFile(client, 'test-bucket', 'large-key', largeFile(), MULTIPART, { ifNoneMatch: '*' })
      ).rejects.toBe(failure);
      expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    });

    it('uploadFile sends no AbortMultipartUpload when a single-part PutObject fails', async () => {
      const { uploadFile } = await import('../../src/storage/operations');
      const failure = preconditionFailed();
      s3Mock.on(PutObjectCommand).rejects(failure);
      const smallFile = path.join(tempDir, 'small.bin');
      fs.writeFileSync(smallFile, Buffer.alloc(1024, 'a'));

      await expect(
        uploadFile(client, 'test-bucket', 'small-key', smallFile, MULTIPART, { ifNoneMatch: '*' })
      ).rejects.toBe(failure);
      expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0);
    });

    it('createStreamUpload sends AbortMultipartUpload and rethrows the original error when Complete is rejected', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      const failure = preconditionFailed();
      s3Mock.on(CompleteMultipartUploadCommand).rejects(failure);
      s3Mock.on(AbortMultipartUploadCommand).resolves({});

      const body = Readable.from([Buffer.alloc(12 * 1024 * 1024, 'z')]);
      const upload = createStreamUpload(client, 'test-bucket', 'stream-key', body, MULTIPART, {
        ifNoneMatch: '*',
      });
      await expect(upload.done()).rejects.toBe(failure);

      const aborts = s3Mock.commandCalls(AbortMultipartUploadCommand);
      expect(aborts).toHaveLength(1);
      expect(aborts[0].args[0].input).toEqual({
        Bucket: 'test-bucket',
        Key: 'stream-key',
        UploadId: 'upload-1',
      });
    });
  });

  describe('getObjectStream', () => {
    it('returns the raw body stream and metadata, without writing anything to disk', async () => {
      const mockStream = new Readable();
      mockStream.push('raw-bytes');
      mockStream.push(null);
      s3Mock.on(GetObjectCommand).resolves({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Body: mockStream as any,
        Metadata: { 'cloud-cache-sha256': 'abc' },
      });

      const { getObjectStream } = await import('../../src/storage/operations');
      const { body, metadata } = await getObjectStream(client, 'test-bucket', 'stream-key');
      expect(metadata).toEqual({ 'cloud-cache-sha256': 'abc' });

      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString()).toBe('raw-bytes');
    });

    it('throws when the response body is empty', async () => {
      s3Mock.on(GetObjectCommand).resolves({});
      const { getObjectStream } = await import('../../src/storage/operations');
      await expect(getObjectStream(client, 'test-bucket', 'empty-key')).rejects.toThrow(
        'Empty response body received'
      );
    });
  });

  describe('createStreamUpload', () => {
    it('uploads a readable stream body with no metadata by default', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"streamed"' });

      const body = Readable.from([Buffer.alloc(1024, 'x')]);
      const upload = createStreamUpload(client, 'test-bucket', 'stream-upload-key', body);
      const result = await upload.done();

      expect((result as { ETag?: string }).ETag).toBe('"streamed"');
      const [call] = s3Mock.commandCalls(PutObjectCommand);
      expect(call.args[0].input).toMatchObject({ Bucket: 'test-bucket', Key: 'stream-upload-key' });
      expect(call.args[0].input.Metadata).toBeUndefined();
    });

    it('passes ifNoneMatch through when given', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"cond"' });

      const body = Readable.from([Buffer.alloc(10, 'y')]);
      const upload = createStreamUpload(client, 'test-bucket', 'cond-key', body, MULTIPART, {
        ifNoneMatch: '*',
      });
      await upload.done();

      const [call] = s3Mock.commandCalls(PutObjectCommand);
      expect(call.args[0].input).toMatchObject({ IfNoneMatch: '*' });
    });

    it('passes tagging through when given', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"tagged"' });

      const body = Readable.from([Buffer.alloc(10, 'y')]);
      const upload = createStreamUpload(client, 'test-bucket', 'tagged-key', body, MULTIPART, {
        tagging: 'repo=acme%2Fapp',
      });
      await upload.done();

      const [call] = s3Mock.commandCalls(PutObjectCommand);
      expect(call.args[0].input.Tagging).toBe('repo=acme%2Fapp');
    });

    it('splits a stream by the given part size, same rule as uploadFile', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload-1' });
      s3Mock.on(UploadPartCommand).resolves({ ETag: '"part"' });
      s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"multipart"' });

      const body = Readable.from([Buffer.alloc(12 * 1024 * 1024, 'z')]);
      const upload = createStreamUpload(client, 'test-bucket', 'large-stream-key', body, {
        partSize: 6 * 1024 * 1024,
      });
      await upload.done();

      expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(2);
    });

    it('uploads a 12 MiB stream as one 64 MiB part when no part size is given', async () => {
      const { createStreamUpload } = await import('../../src/storage/operations');
      s3Mock.on(PutObjectCommand).resolves({ ETag: '"single"' });

      const body = Readable.from([Buffer.alloc(12 * 1024 * 1024, 'z')]);
      const upload = createStreamUpload(client, 'test-bucket', 'large-stream-key', body);
      await upload.done();

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(0);
    });
  });

  describe('object tags', () => {
    it('putObjectTags replaces the whole tag set', async () => {
      const { PutObjectTaggingCommand } = await import('@aws-sdk/client-s3');
      const { putObjectTags } = await import('../../src/storage/operations');
      s3Mock.on(PutObjectTaggingCommand).resolves({});

      await putObjectTags(client, 'b', 'k', [
        { Key: 'team', Value: 'platform' },
        { Key: 'cloud-cache-sha256', Value: 'abc' },
      ]);

      const [call] = s3Mock.commandCalls(PutObjectTaggingCommand);
      expect(call.args[0].input.Tagging).toEqual({
        TagSet: [
          { Key: 'team', Value: 'platform' },
          { Key: 'cloud-cache-sha256', Value: 'abc' },
        ],
      });
    });

    it('getObjectTags returns the tags as a plain object', async () => {
      const { GetObjectTaggingCommand } = await import('@aws-sdk/client-s3');
      const { getObjectTags } = await import('../../src/storage/operations');
      s3Mock.on(GetObjectTaggingCommand).resolves({
        TagSet: [
          { Key: 'cloud-cache-sha256', Value: 'abc' },
          { Key: 'team', Value: 'platform' },
        ],
      });

      await expect(getObjectTags(client, 'b', 'k')).resolves.toEqual({
        'cloud-cache-sha256': 'abc',
        team: 'platform',
      });
    });

    it('downloadFile reports the tag count from the GetObject response', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-download-'));
      s3Mock.on(GetObjectCommand).resolves({
        Body: Readable.from([Buffer.from('data')]) as never,
        TagCount: 2,
      });
      try {
        const result = await downloadFile(client, 'b', 'k', path.join(tempDir, 'out.bin'));
        expect(result.tagCount).toBe(2);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('replaceObjectMetadata', () => {
    it('copies the object onto itself with REPLACE and keeps tags', async () => {
      s3Mock.on(CopyObjectCommand).resolves({ CopyObjectResult: { ETag: '"copied"' } });

      const result = await replaceObjectMetadata(client, 'b', 'a/b c.tar.zst', {
        'cloud-cache-sha256': 'x',
      });

      expect(result).toEqual({ etag: '"copied"' });
      const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
      expect(input).toMatchObject({
        Bucket: 'b',
        Key: 'a/b c.tar.zst',
        CopySource: 'b/a/b%20c.tar.zst',
        MetadataDirective: 'REPLACE',
        TaggingDirective: 'COPY',
        Metadata: { 'cloud-cache-sha256': 'x' },
      });
      expect(input.CopySourceIfMatch).toBeUndefined();
    });

    it('percent-encodes each key segment, so # ? & and % in a key are safe', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});

      await replaceObjectMetadata(client, 'b', 'a/c#1 100%/cache.tar.zst', { m: 'v' });

      const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
      expect(input.CopySource).toBe('b/a/c%231%20100%25/cache.tar.zst');
    });

    it('sends CopySourceIfMatch when an ETag is given, so it cannot stamp another writer', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});

      await replaceObjectMetadata(client, 'b', 'k', { m: 'v' }, '"uploaded"');

      const input = s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input;
      expect(input.CopySourceIfMatch).toBe('"uploaded"');
    });
  });
});
