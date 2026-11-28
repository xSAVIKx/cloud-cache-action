import { jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { makeTempDir, removeDir } from '../../support/tempTree';

const mockInfo = jest.fn<(message: string) => void>();
jest.unstable_mockModule('@actions/core', () => ({
  info: mockInfo,
  debug: jest.fn(),
  warning: jest.fn(),
}));

type HasherFactory = typeof import('../../../src/archive/prefixHasher').createPrefixHasher;
const realHasher = await import('../../../src/archive/prefixHasher');
let hasherOverride: HasherFactory | undefined;
jest.unstable_mockModule('../../../src/archive/prefixHasher', () => ({
  ...realHasher,
  createPrefixHasher: (filePath: string) =>
    (hasherOverride ?? realHasher.createPrefixHasher)(filePath),
}));

const {
  ObjectChangedError,
  RangeNotSupportedError,
  downloadFileInParts,
  openObjectPartsStream,
  planParts,
  shouldDownloadInParts,
} = await import('../../../src/storage/parallelDownload');

const s3Mock = mockClient(S3Client);
const BUCKET = 'bucket';
const KEY = 'repo/main/key/version/cache.tar.zst';

/** 25 distinct bytes, so a part written at the wrong offset changes the result. */
const DATA = Buffer.from(Array.from({ length: 25 }, (_, i) => 65 + i));
const METADATA = { 'cloud-cache-sha256': 'abc' };

interface RangeRequest {
  start: number;
  end: number;
}

function parseRange(input: { Range?: string }): RangeRequest {
  const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? '');
  if (!match) {
    throw new Error(`Unexpected Range header: ${input.Range}`);
  }
  return { start: Number(match[1]), end: Number(match[2]) };
}

function partResponse(range: RangeRequest, data: Buffer = DATA) {
  const slice = data.subarray(range.start, range.end + 1);
  return {
    Body: Readable.from([slice]),
    ContentLength: slice.length,
    ContentRange: `bytes ${range.start}-${range.end}/${data.length}`,
    ETag: '"etag-a"',
    Metadata: METADATA,
    $metadata: { httpStatusCode: 206 },
  };
}

/** Serves every range of DATA; `override` can replace the response for one range. */
function serveRanges(override?: (range: RangeRequest, calls: number) => unknown) {
  const seen = new Map<string, number>();
  s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
    const range = parseRange(input);
    const id = `${range.start}-${range.end}`;
    const calls = (seen.get(id) ?? 0) + 1;
    seen.set(id, calls);
    return override?.(range, calls) ?? partResponse(range);
  });
  return seen;
}

const rangesRequested = (): string[] =>
  s3Mock
    .commandCalls(GetObjectCommand)
    .map((call) => (call.args[0].input as { Range?: string }).Range ?? '');

const options = { size: DATA.length, partSize: 10, concurrency: 2, retries: 1 };

let tempDir: string;
let destination: string;

beforeEach(() => {
  s3Mock.reset();
  hasherOverride = undefined;
  mockInfo.mockReset();
  tempDir = makeTempDir('parallel-download-');
  destination = path.join(tempDir, 'nested', 'cache.tar.zst');
});

afterEach(() => {
  removeDir(tempDir);
});

const client = () => new S3Client({ region: 'us-east-1' });

describe('planParts', () => {
  it('splits a size into consecutive inclusive ranges, the last one shorter', () => {
    expect(planParts(25, 10)).toEqual([
      { index: 0, start: 0, end: 9 },
      { index: 1, start: 10, end: 19 },
      { index: 2, start: 20, end: 24 },
    ]);
  });

  it('plans one part when the size fits, and none for an empty object', () => {
    expect(planParts(10, 10)).toEqual([{ index: 0, start: 0, end: 9 }]);
    expect(planParts(0, 10)).toEqual([]);
  });

  it('rejects a non-positive part size', () => {
    expect(() => planParts(10, 0)).toThrow(/positive integer/);
  });
});

describe('shouldDownloadInParts', () => {
  it('is true only when the object is larger than one part', () => {
    expect(shouldDownloadInParts(11, 10)).toBe(true);
    expect(shouldDownloadInParts(10, 10)).toBe(false);
    expect(shouldDownloadInParts(0, 10)).toBe(false);
  });
});

describe('downloadFileInParts', () => {
  it('writes every part at its offset and returns the metadata and part count', async () => {
    serveRanges();
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options);
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(result).toEqual({ metadata: METADATA, parts: 3 });
    expect(rangesRequested().sort()).toEqual(['bytes=0-9', 'bytes=10-19', 'bytes=20-24']);
  });

  it('never has more than `concurrency` requests in flight', async () => {
    const open: PassThrough[] = [];
    let inFlight = 0;
    let peak = 0;
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      const range = parseRange(input);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const body = new PassThrough();
      body.on('close', () => {
        inFlight -= 1;
      });
      open.push(body);
      return { ...partResponse(range), Body: body };
    });
    const download = downloadFileInParts(client(), BUCKET, KEY, destination, options);
    // Release the parts one at a time, in request order, as they appear.
    const release = async (): Promise<void> => {
      for (let released = 0; released < 3; released++) {
        while (open.length <= released) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const body = open[released];
        const range = parseRange({ Range: rangesRequested()[released] });
        body.end(DATA.subarray(range.start, range.end + 1));
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all([download, release()]);
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(peak).toBe(2);
  });

  it('throws RangeNotSupportedError, before creating the file, when the server returns 200', async () => {
    serveRanges((range) => ({ ...partResponse(range), $metadata: { httpStatusCode: 200 } }));
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      RangeNotSupportedError
    );
    expect(fs.existsSync(destination)).toBe(false);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  it('fails when a part response declares a different length than the range asked for', async () => {
    serveRanges((range) =>
      range.start === 10 ? { ...partResponse(range), ContentLength: 3 } : undefined
    );
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      /returned 3 bytes for range 10-19; expected 10/
    );
  });

  it('retries one part on a dropped connection without refetching the others', async () => {
    serveRanges((range, calls) => {
      if (range.start === 10 && calls === 1) {
        const body = new PassThrough();
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        setImmediate(() => body.destroy(error));
        return { ...partResponse(range), Body: body };
      }
      return undefined;
    });
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options);
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(result.parts).toBe(3);
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(2);
    expect(rangesRequested().filter((range) => range === 'bytes=0-9')).toHaveLength(1);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringMatching(/part 2\/3: attempt 1\/2 failed/));
  });

  it('returns the sha256 of the object bytes with hash: true, also when a part is retried', async () => {
    serveRanges((range, calls) => {
      if (range.start === 10 && calls === 1) {
        // Writes a wrong first chunk and then drops, so the retry must overwrite those bytes.
        const body = new PassThrough();
        body.write(Buffer.alloc(4, 0));
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        setImmediate(() => body.destroy(error));
        return { ...partResponse(range), Body: body };
      }
      return undefined;
    });
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options, {
      hash: true,
    });
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(result.sha256).toBe(crypto.createHash('sha256').update(DATA).digest('hex'));
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(2);
  });

  it('hashes in order when the parts complete in reverse order', async () => {
    const bodies = new Map<number, PassThrough>();
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      const range = parseRange(input);
      const body = new PassThrough();
      bodies.set(range.start, body);
      return { ...partResponse(range), Body: body };
    });
    const download = downloadFileInParts(
      client(),
      BUCKET,
      KEY,
      destination,
      { ...options, concurrency: 3 },
      { hash: true }
    );
    // Ends the last part first and the first part last, each after the earlier one is written.
    const release = async (): Promise<void> => {
      for (const start of [20, 10, 0]) {
        while (!bodies.has(start)) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        bodies.get(start)?.end(DATA.subarray(start, Math.min(start + 10, DATA.length)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const [result] = await Promise.all([download, release()]);
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(result.sha256).toBe(crypto.createHash('sha256').update(DATA).digest('hex'));
  });

  it('stops the hash and rejects with the part error when a part fails for good', async () => {
    serveRanges((range) => {
      if (range.start === 10) {
        throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
      }
      return undefined;
    });
    await expect(
      downloadFileInParts(client(), BUCKET, KEY, destination, options, { hash: true })
    ).rejects.toThrow('AccessDenied');
  });

  it('returns no sha256 without hash: true', async () => {
    serveRanges();
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options);
    expect(result.sha256).toBeUndefined();
  });

  it('retries a part whose body ends short of its declared length', async () => {
    serveRanges((range, calls) =>
      range.start === 20 && calls === 1
        ? { ...partResponse(range), Body: Readable.from([DATA.subarray(20, 22)]) }
        : undefined
    );
    await downloadFileInParts(client(), BUCKET, KEY, destination, options);
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(rangesRequested().filter((range) => range === 'bytes=20-24')).toHaveLength(2);
  });

  it('rejects with the part error once retries are exhausted', async () => {
    serveRanges((range) => {
      if (range.start === 10) {
        const body = new PassThrough();
        setImmediate(() =>
          body.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
        );
        return { ...partResponse(range), Body: body };
      }
      return undefined;
    });
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      'socket hang up'
    );
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(2);
  });

  it('sends the ETag of the first part as IfMatch on every later part', async () => {
    serveRanges();
    await downloadFileInParts(client(), BUCKET, KEY, destination, options);
    const inputs = s3Mock
      .commandCalls(GetObjectCommand)
      .map((call) => call.args[0].input as { Range?: string; IfMatch?: string });
    expect(inputs.find((input) => input.Range === 'bytes=0-9')?.IfMatch).toBeUndefined();
    expect(
      inputs.filter((input) => input.Range !== 'bytes=0-9').map((input) => input.IfMatch)
    ).toEqual(['"etag-a"', '"etag-a"']);
  });

  it('fails without a retry when a later part has a different ETag', async () => {
    serveRanges((range) =>
      range.start === 10 ? { ...partResponse(range), ETag: '"etag-b"' } : undefined
    );
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      ObjectChangedError
    );
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(1);
  });

  it('fails without a retry when the server answers 412 to IfMatch', async () => {
    serveRanges((range) => {
      if (range.start === 10) {
        throw Object.assign(new Error('PreconditionFailed'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      return undefined;
    });
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      /object changed during the download/
    );
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(1);
  });

  it('fails when the Content-Range total differs from the expected size', async () => {
    serveRanges((range) =>
      range.start === 10 ? { ...partResponse(range), ContentRange: 'bytes 10-19/99' } : undefined
    );
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      /object changed during the download/
    );
  });

  it('rejects a part that delivers more bytes than its range, without a retry', async () => {
    serveRanges((range) =>
      range.start === 10
        ? {
            ...partResponse(range),
            Body: Readable.from([Buffer.concat([DATA.subarray(10, 20), Buffer.from('xyz')])]),
            ContentLength: undefined,
          }
        : undefined
    );
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      /Part 2 \(bytes 10-19\) delivered more than 10 bytes/
    );
    expect(rangesRequested().filter((range) => range === 'bytes=10-19')).toHaveLength(1);
  });

  it('rejects a part response with no body', async () => {
    serveRanges((range) =>
      range.start === 10 ? { ...partResponse(range), Body: undefined } : undefined
    );
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      /Empty response body/
    );
  });

  it('returns no sha256 when the hash worker cannot start', async () => {
    hasherOverride = () => {
      throw new Error('no worker');
    };
    serveRanges();
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options, {
      hash: true,
    });
    expect(result.sha256).toBeUndefined();
    expect(fs.readFileSync(destination)).toEqual(DATA);
  });

  it('returns no sha256, and closes the hasher, when the hash finish rejects', async () => {
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    hasherOverride = () => ({
      advance: () => undefined,
      finish: () => Promise.reject(new Error('worker died')),
      close,
    });
    serveRanges();
    const result = await downloadFileInParts(client(), BUCKET, KEY, destination, options, {
      hash: true,
    });
    expect(result.sha256).toBeUndefined();
    expect(fs.readFileSync(destination)).toEqual(DATA);
    expect(close).toHaveBeenCalled();
  });

  it('does not retry a failure the SDK already retried', async () => {
    serveRanges((range) => {
      if (range.start === 20) {
        throw Object.assign(new Error('InternalError'), {
          $metadata: { httpStatusCode: 500, attempts: 3 },
        });
      }
      return undefined;
    });
    await expect(downloadFileInParts(client(), BUCKET, KEY, destination, options)).rejects.toThrow(
      'InternalError'
    );
    expect(rangesRequested().filter((range) => range === 'bytes=20-24')).toHaveLength(1);
  });
});

describe('openObjectPartsStream', () => {
  const collect = async (body: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };

  it('yields the object bytes in order and reports the metadata and part count', async () => {
    serveRanges();
    const stream = await openObjectPartsStream(client(), BUCKET, KEY, options);
    expect(stream.metadata).toEqual(METADATA);
    expect(stream.parts).toBe(3);
    expect(await collect(stream.body)).toEqual(DATA);
  });

  it('keeps the order even when a later part arrives first', async () => {
    serveRanges((range) => {
      if (range.start === 0) {
        const body = new PassThrough();
        setTimeout(() => body.end(DATA.subarray(0, 10)), 30);
        return { ...partResponse(range), Body: body };
      }
      return undefined;
    });
    const stream = await openObjectPartsStream(client(), BUCKET, KEY, options);
    expect(await collect(stream.body)).toEqual(DATA);
  });

  it('prefetches at most `concurrency` parts ahead of the reader', async () => {
    const gate = new PassThrough();
    serveRanges((range) =>
      range.start === 0 ? { ...partResponse(range), Body: gate } : undefined
    );
    const stream = await openObjectPartsStream(client(), BUCKET, KEY, {
      ...options,
      concurrency: 2,
    });
    const reading = collect(stream.body);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rangesRequested()).toEqual(['bytes=0-9', 'bytes=10-19']);
    gate.end(DATA.subarray(0, 10));
    expect(await reading).toEqual(DATA);
    expect(rangesRequested()).toEqual(['bytes=0-9', 'bytes=10-19', 'bytes=20-24']);
  });

  it('rejects before returning a stream when the server ignores Range', async () => {
    serveRanges((range) => ({ ...partResponse(range), $metadata: { httpStatusCode: 200 } }));
    await expect(openObjectPartsStream(client(), BUCKET, KEY, options)).rejects.toThrow(
      RangeNotSupportedError
    );
  });

  it('fails the stream when a later part fails for good', async () => {
    serveRanges((range) => {
      if (range.start === 20) {
        throw Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });
      }
      return undefined;
    });
    const stream = await openObjectPartsStream(client(), BUCKET, KEY, options);
    await expect(pipeline(stream.body, new PassThrough().resume())).rejects.toThrow('AccessDenied');
  });

  it('requests no further parts once the consumer destroys the stream', async () => {
    const gate = new PassThrough();
    serveRanges((range) =>
      range.start === 10 ? { ...partResponse(range), Body: gate } : undefined
    );
    const stream = await openObjectPartsStream(client(), BUCKET, KEY, {
      ...options,
      concurrency: 1,
    });
    const first = await new Promise<Buffer>((resolve) => stream.body.once('data', resolve));
    expect(first).toEqual(DATA.subarray(0, 10));
    stream.body.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.end(DATA.subarray(10, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rangesRequested()).not.toContain('bytes=20-24');
  });
});
