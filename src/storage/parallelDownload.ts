/**
 * Ranged, parallel object downloads. A restore of a large archive is bound by the throughput of
 * one HTTP connection when it uses a single GetObject; splitting the object into `Range` parts
 * fetched concurrently uses the whole link a runner has. Each part is retried on its own, so a
 * dropped connection costs one part, not the whole download.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { isRetryableStreamError, withRetry } from './retry';

/** One `Range` request: `start` and `end` are inclusive byte offsets, as in HTTP. */
export interface PartRange {
  index: number;
  start: number;
  end: number;
}

export interface PartDownloadOptions {
  /** Object size in bytes, known from the listing or HEAD that found the object. */
  size: number;
  /** Bytes per `Range` request; the last part is shorter when the size does not divide. */
  partSize: number;
  /** Parts in flight at once. */
  concurrency: number;
  /** Extra attempts per part for stream failures the SDK does not retry itself. */
  retries: number;
}

export interface PartDownloadResult {
  /** Object metadata from the first part's response; undefined when the object carries none. */
  metadata?: Record<string, string>;
  /** How many tags the object carries, from the first part's response. */
  tagCount?: number;
  /** How many ranged requests the object was split into. */
  parts: number;
}

export interface PartsStreamResult extends PartDownloadResult {
  /** The object's bytes in order, assembled from the parts as they arrive. */
  body: Readable;
}

/**
 * Thrown when the server answers a `Range` request with the whole object (HTTP 200) instead of
 * the requested part (HTTP 206). Callers fall back to a single GetObject.
 */
export class RangeNotSupportedError extends Error {
  constructor(bucket: string, key: string) {
    super(`s3://${bucket}/${key} does not support ranged GET requests`);
    this.name = 'RangeNotSupportedError';
  }
}

/**
 * A part body that ended before its declared length. Reported with the same code Node uses for a
 * stream that closed early, so the per-part retry treats it as the dropped connection it is.
 */
class ShortPartError extends Error {
  readonly code = 'ERR_STREAM_PREMATURE_CLOSE';
  constructor(part: PartRange, received: number) {
    super(
      `Part ${part.index + 1} (bytes ${part.start}-${part.end}) ended after ${received} of ${part.end - part.start + 1} bytes`
    );
    this.name = 'ShortPartError';
  }
}

/** Splits `size` bytes into consecutive ranges of at most `partSize` bytes. */
export function planParts(size: number, partSize: number): PartRange[] {
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`Cannot plan parts for an object size of ${size}`);
  }
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`Part size must be a positive integer; got ${partSize}`);
  }
  const parts: PartRange[] = [];
  for (let start = 0; start < size; start += partSize) {
    parts.push({ index: parts.length, start, end: Math.min(start + partSize, size) - 1 });
  }
  return parts;
}

/** True when an object of `size` bytes is worth more than one request. */
export function shouldDownloadInParts(size: number, partSize: number): boolean {
  return size > partSize;
}

interface RangeResponse {
  body: Readable;
  metadata?: Record<string, string>;
  tagCount?: number;
}

/** Fetches one part and checks that the server honoured the range. */
async function getObjectRange(
  client: S3Client,
  bucket: string,
  key: string,
  part: PartRange,
  signal: AbortSignal
): Promise<RangeResponse> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${part.start}-${part.end}` }),
    { abortSignal: signal }
  );
  const body = response.Body as Readable | undefined;
  if (!body) {
    throw new Error(`Empty response body received from S3 for key: ${key}`);
  }
  if (response.$metadata?.httpStatusCode === 200) {
    body.destroy();
    throw new RangeNotSupportedError(bucket, key);
  }
  const expected = part.end - part.start + 1;
  if (response.ContentLength !== undefined && response.ContentLength !== expected) {
    body.destroy();
    throw new Error(
      `s3://${bucket}/${key} returned ${response.ContentLength} bytes for range ${part.start}-${part.end}; expected ${expected}`
    );
  }
  return { body, metadata: response.Metadata, tagCount: response.TagCount };
}

/**
 * Feeds one part's body to `sink` chunk by chunk and confirms the byte count. The sink receives
 * the offset of every chunk within the object, so a file writer can place it without buffering.
 */
async function consumePart(
  part: PartRange,
  body: Readable,
  sink: (chunk: Buffer, offset: number) => Promise<void> | void
): Promise<void> {
  const expected = part.end - part.start + 1;
  let received = 0;
  try {
    for await (const chunk of body) {
      const buffer = chunk as Buffer;
      if (received + buffer.length > expected) {
        throw new Error(
          `Part ${part.index + 1} (bytes ${part.start}-${part.end}) delivered more than ${expected} bytes`
        );
      }
      await sink(buffer, part.start + received);
      received += buffer.length;
    }
  } finally {
    body.destroy();
  }
  if (received !== expected) {
    throw new ShortPartError(part, received);
  }
}

/**
 * Shared machinery: fetches parts with per-part retries and one abort signal for the whole
 * download. The first part is requested up front, so an unsupported `Range` (or any other
 * immediate failure) surfaces before the caller opens a file or spawns tar.
 */
class PartSource {
  readonly controller = new AbortController();
  readonly parts: PartRange[];
  private first?: Promise<RangeResponse>;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly key: string,
    private readonly options: PartDownloadOptions
  ) {
    this.parts = planParts(options.size, options.partSize);
    if (this.parts.length === 0) {
      throw new Error(`Nothing to download: s3://${bucket}/${key} is empty`);
    }
  }

  /**
   * Requests the first part and returns its metadata and tag count; the body is consumed later,
   * in order.
   */
  async open(): Promise<Pick<RangeResponse, 'metadata' | 'tagCount'>> {
    this.first = this.fetch(this.parts[0]);
    try {
      const { metadata, tagCount } = await this.first;
      return { metadata, tagCount };
    } catch (err) {
      this.first = undefined;
      throw err;
    }
  }

  /** Downloads one part through `sink`, retrying the fetch and the consumption together. */
  download(
    part: PartRange,
    sink: (chunk: Buffer, offset: number) => Promise<void> | void
  ): Promise<void> {
    return withRetry(
      async () => {
        let response: RangeResponse;
        if (part.index === 0 && this.first) {
          response = await this.first;
          this.first = undefined;
        } else {
          response = await this.fetch(part);
        }
        await consumePart(part, response.body, sink);
      },
      {
        retries: this.options.retries,
        operationName: `Download of ${this.key} part ${part.index + 1}/${this.parts.length}`,
        shouldRetry: (err) => !this.controller.signal.aborted && isRetryableStreamError(err),
      }
    );
  }

  /** Stops every request still in flight; later fetches fail with an AbortError. */
  abort(): void {
    this.controller.abort();
    this.first?.then((response) => response.body.destroy()).catch(() => undefined);
  }

  private fetch(part: PartRange): Promise<RangeResponse> {
    return getObjectRange(this.client, this.bucket, this.key, part, this.controller.signal);
  }
}

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight. The first failure calls
 * `onFailure` at once (so the caller can abort the other calls), and is rethrown once every
 * worker has stopped.
 */
async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  onFailure: () => void
): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
          onFailure();
        }
      }
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failed) {
    throw failure;
  }
}

/**
 * Downloads an object into `destinationPath` as concurrent ranged parts. Each part's chunks are
 * written at their offset as they arrive, so the memory used is the SDK's socket buffers, not the
 * parts. Throws `RangeNotSupportedError` before the file exists when the server ignores `Range`.
 */
export async function downloadFileInParts(
  client: S3Client,
  bucket: string,
  key: string,
  destinationPath: string,
  options: PartDownloadOptions
): Promise<PartDownloadResult> {
  const source = new PartSource(client, bucket, key, options);
  const { metadata, tagCount } = await source.open();

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const handle = await fs.promises.open(destinationPath, 'w');
  try {
    await handle.truncate(options.size);
    await forEachConcurrently(
      source.parts,
      options.concurrency,
      (part) =>
        source.download(part, async (chunk, offset) => {
          await handle.write(chunk, 0, chunk.length, offset);
        }),
      () => source.abort()
    );
  } finally {
    await handle.close();
  }
  return { metadata, tagCount, parts: source.parts.length };
}

/**
 * Opens an object as one ordered stream assembled from concurrent ranged parts. Up to
 * `concurrency` parts are fetched ahead of the reader and each is buffered whole until its turn,
 * so memory is bounded by `concurrency * partSize`. Resolves once the first part has been
 * requested, so an unsupported `Range` is reported before the caller starts a consumer.
 */
export async function openObjectPartsStream(
  client: S3Client,
  bucket: string,
  key: string,
  options: PartDownloadOptions
): Promise<PartsStreamResult> {
  const source = new PartSource(client, bucket, key, options);
  const { metadata, tagCount } = await source.open();
  const window = Math.max(1, options.concurrency);

  const bufferPart = (part: PartRange): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    return source
      .download(part, (chunk) => {
        chunks.push(chunk);
      })
      .then(() => Buffer.concat(chunks));
  };

  async function* ordered(): AsyncGenerator<Buffer> {
    const pending: Array<Promise<Buffer>> = [];
    let next = 0;
    // Failures of prefetched parts must not become unhandled rejections while an earlier part
    // is still streaming; the error resurfaces when that part's turn comes.
    const start = (): void => {
      const promise = bufferPart(source.parts[next++]);
      promise.catch(() => undefined);
      pending.push(promise);
    };
    try {
      while (pending.length < window && next < source.parts.length) {
        start();
      }
      while (pending.length > 0) {
        const buffer = await (pending.shift() as Promise<Buffer>);
        // A consumer that destroyed the stream while this part was in flight has already
        // aborted the source; do not start another part for it.
        if (next < source.parts.length && !source.controller.signal.aborted) {
          start();
        }
        yield buffer;
      }
    } finally {
      // Reached on completion, on an error and when the consumer destroys the stream early.
      source.abort();
    }
  }

  // Not Readable.from(): its destroy waits for the generator, which cannot be returned while it
  // awaits a part, and the requests must stop as soon as the consumer destroys the stream.
  const iterator = ordered();
  let reading = false;
  const body = new Readable({
    read() {
      if (reading) {
        return;
      }
      reading = true;
      iterator.next().then(
        ({ value, done }) => {
          reading = false;
          if (this.destroyed) {
            return;
          }
          this.push(done ? null : value);
        },
        (err) => this.destroy(err as Error)
      );
    },
    destroy(err, callback) {
      source.abort();
      iterator.return(undefined).catch(() => undefined);
      callback(err);
    },
  });
  return { body, metadata, tagCount, parts: source.parts.length };
}
