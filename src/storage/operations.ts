import {
  S3Client,
  AbortMultipartUploadCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  ListObjectsV2Command,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { log } from '../ci/log';
import { createSha256Tap } from '../archive/checksum';
import { Defaults } from '../constants';

export interface CacheObjectMetadata {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
  /** User metadata from the HeadObject response; undefined when the server returns none. */
  metadata?: Record<string, string>;
}

export async function checkObjectExists(
  client: S3Client,
  bucket: string,
  key: string
): Promise<CacheObjectMetadata | null> {
  try {
    const cmd = new HeadObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const response = await client.send(cmd);
    return {
      key,
      size: response.ContentLength || 0,
      lastModified: response.LastModified,
      etag: response.ETag,
      metadata: response.Metadata,
    };
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw err;
  }
}

/** Lists every object under `prefix`, following continuation tokens, in the order S3 lists them. */
export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  pageSize = 1000
): Promise<CacheObjectMetadata[]> {
  const objects: CacheObjectMetadata[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: pageSize,
        ContinuationToken: continuationToken,
      })
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) {
        objects.push({
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified,
          etag: object.ETag,
        });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

/**
 * The most recently modified object under `prefix` that `accept` allows. When timestamps tie,
 * the first object listed wins.
 */
export async function findNewestObject(
  client: S3Client,
  bucket: string,
  prefix: string,
  accept: (key: string) => boolean,
  pageSize = 1000
): Promise<CacheObjectMetadata | undefined> {
  let newest: CacheObjectMetadata | undefined;
  for (const object of await listObjects(client, bucket, prefix, pageSize)) {
    if (!accept(object.key)) {
      continue;
    }
    if (!newest || (object.lastModified?.getTime() ?? 0) > (newest.lastModified?.getTime() ?? 0)) {
      newest = object;
    }
  }
  return newest;
}

export interface DownloadResult {
  /** Object metadata from the GetObject response; undefined when the object carries none. */
  metadata?: Record<string, string>;
  /** How many tags the object carries, so a caller can skip a pointless GetObjectTagging. */
  tagCount?: number;
  /** The hex sha256 of the bytes written; set only when the call asked for `hash: true`. */
  sha256?: string;
}

export interface ObjectStreamResult {
  /** The raw GetObject response body; the caller pipes it, rather than a file on disk. */
  body: Readable;
  /** Object metadata from the GetObject response; undefined when the object carries none. */
  metadata?: Record<string, string>;
  /** How many tags the object carries, so a caller can skip a pointless GetObjectTagging. */
  tagCount?: number;
}

export interface ObjectTagLike {
  Key: string;
  Value: string;
}

/** Replaces the object's whole tag set; S3 has no partial tag update. */
export async function putObjectTags(
  client: S3Client,
  bucket: string,
  key: string,
  tags: readonly ObjectTagLike[]
): Promise<void> {
  await client.send(
    new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet: [...tags] } })
  );
}

/** Reads the object's tags as a plain object; an absent or malformed entry is skipped. */
export async function getObjectTags(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Record<string, string>> {
  const response = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
  const tags: Record<string, string> = {};
  for (const tag of response.TagSet ?? []) {
    if (tag.Key !== undefined && tag.Value !== undefined) {
      tags[tag.Key] = tag.Value;
    }
  }
  return tags;
}

/** How a multipart upload is split and fanned out; unset fields take the actions/cache defaults. */
export interface UploadTransfer {
  /** Bytes per part; S3 parts must be at least 5 MiB, so a smaller value uses the default. */
  partSize?: number;
  /** Parts in flight at once. */
  concurrency?: number;
}

function resolvePartSize(transfer?: UploadTransfer): number {
  const partSize = transfer?.partSize;
  return partSize && partSize >= Defaults.MinUploadChunkSize
    ? partSize
    : Defaults.DefaultUploadChunkSize;
}

function resolveQueueSize(transfer?: UploadTransfer): number {
  return Math.max(1, transfer?.concurrency ?? Defaults.DefaultUploadConcurrency);
}

/** The Node default read size for a file stream. A smaller read is not useful. */
const MIN_UPLOAD_READ_SIZE = 64 * 1024;
/** A read larger than this gave almost no more speed in the local benchmark, but more memory. */
const MAX_UPLOAD_READ_SIZE = 8 * 1024 * 1024;
/** One part takes this many reads. */
const READS_PER_PART = 16;

/**
 * The read size for the archive file in a file-mode upload: 1/16 of the part size, from 64 KiB
 * to 8 MiB. The Node default of 64 KiB needs 16384 reads for 1 GiB. On a busy host, each read
 * waits for the libuv thread pool and for the event loop, and the reads then limit the upload.
 *
 * The read size is not the part size, because of how lib-storage cuts parts from a stream. It
 * cuts a part only when it holds more than one part of data. It then copies the reads into one
 * buffer, and the part is a view of that buffer. Each part in flight thus holds `partSize` plus
 * one read. A read of `partSize` would make each part hold two parts of memory. With 1/16, the
 * memory that `transferTuning.ts` budgets as `(concurrency + 1) * partSize` grows by 1/16.
 */
export function uploadReadSize(partSize: number): number {
  return Math.min(
    MAX_UPLOAD_READ_SIZE,
    Math.max(MIN_UPLOAD_READ_SIZE, Math.floor(partSize / READS_PER_PART))
  );
}

export interface UploadOptions {
  /** Stored as `x-amz-meta-*` headers and returned by HeadObject/GetObject. */
  metadata?: Record<string, string>;
  /**
   * Pass-through for a conditional write (`'*'` to fail if the key already exists). Set by
   * saveToS3 to detect a concurrent save; forwarded to PutObjectCommand for a single-part
   * upload and to CompleteMultipartUploadCommand (where S3 evaluates it) for a multipart one.
   */
  ifNoneMatch?: string;
  /** Object tags as the `Tagging` header value (see encodeTagging); omitted when undefined. */
  tagging?: string;
}

/**
 * What `createStreamUpload` hands back: the upload's outcome, and a way to stop it early. `done()`
 * goes through the same abort-on-failure handling as `uploadFile`.
 */
export interface StreamUpload {
  /** `VersionId` is the version the upload wrote, when the provider reports one. */
  done(): Promise<{ ETag?: string; VersionId?: string }>;
  /** Stops the upload: `done()` rejects promptly, and no further parts are sent. */
  abort(): Promise<void>;
}

/**
 * Awaits `upload.done()`. When it rejects after a multipart upload was created, sends
 * AbortMultipartUpload for it before rethrowing the original error, unchanged.
 *
 * lib-storage aborts the multipart upload itself when a part fails, when the part count is wrong,
 * and (since 3.1169.0) when CompleteMultipartUpload fails. It does not always do so when the
 * caller stops the upload with `abort()`: `done()` rejects at once, and its own abort can come
 * late or not at all. Without this abort, such an upload leaves its parts behind, stored and
 * billed until a lifecycle rule removes them. When lib-storage has already aborted the upload,
 * this second abort fails with NoSuchUpload, which is expected and only logged at debug level.
 */
async function completeOrAbort(
  client: S3Client,
  bucket: string,
  key: string,
  upload: Upload
): Promise<{ ETag?: string; VersionId?: string }> {
  try {
    return await upload.done();
  } catch (err) {
    const uploadId = upload.uploadId;
    if (uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
        );
        log.debug(`Aborted multipart upload ${uploadId} for s3://${bucket}/${key}.`);
      } catch (abortErr) {
        const error = abortErr as {
          name?: string;
          message?: string;
          $metadata?: { httpStatusCode?: number };
        };
        const message = `Could not abort multipart upload ${uploadId} for s3://${bucket}/${key}: ${error.message ?? String(abortErr)}`;
        if (error.name === 'NoSuchUpload' || error.$metadata?.httpStatusCode === 404) {
          log.debug(`${message} (it was already aborted).`);
        } else {
          log.warning(
            `${message}. Its parts stay stored until a bucket lifecycle rule (AbortIncompleteMultipartUpload) removes them.`
          );
        }
      }
    }
    throw err;
  }
}

export async function downloadFile(
  client: S3Client,
  bucket: string,
  key: string,
  destinationPath: string,
  options: { hash?: boolean } = {}
): Promise<DownloadResult> {
  // Ensure target folder exists
  const dir = path.dirname(destinationPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await client.send(cmd);
  if (!response.Body) {
    throw new Error(`Empty response body received from S3 for key: ${key}`);
  }

  const fileStream = fs.createWriteStream(destinationPath);
  // One request is bound by the network, so the hash runs on the main thread, in the pipe.
  if (options.hash) {
    const tap = createSha256Tap();
    await pipeline(response.Body as Readable, tap.stream, fileStream);
    return { metadata: response.Metadata, tagCount: response.TagCount, sha256: tap.digest() };
  }
  await pipeline(response.Body as Readable, fileStream);

  return { metadata: response.Metadata, tagCount: response.TagCount };
}

/**
 * Like `downloadFile`, but for streaming (Task 8): returns the response body stream itself
 * instead of writing it to a file, so the caller can pipe it straight into a tar extract.
 */
export async function getObjectStream(
  client: S3Client,
  bucket: string,
  key: string
): Promise<ObjectStreamResult> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`Empty response body received from S3 for key: ${key}`);
  }
  return {
    body: response.Body as Readable,
    metadata: response.Metadata,
    tagCount: response.TagCount,
  };
}

export async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  sourcePath: string,
  transfer?: UploadTransfer,
  options?: UploadOptions
): Promise<{ size: number; etag?: string }> {
  const stats = fs.statSync(sourcePath);
  const partSize = resolvePartSize(transfer);
  const fileStream = fs.createReadStream(sourcePath, { highWaterMark: uploadReadSize(partSize) });

  const parallelUpload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: fileStream,
      Metadata: options?.metadata,
      IfNoneMatch: options?.ifNoneMatch,
      Tagging: options?.tagging,
    },
    partSize,
    queueSize: resolveQueueSize(transfer),
    leavePartsOnError: false,
  });

  parallelUpload.on('httpUploadProgress', (progress) => {
    if (progress.total && progress.loaded) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      log.debug(`Upload progress: ${pct}% (${progress.loaded}/${progress.total} bytes)`);
    }
  });

  const result = await completeOrAbort(client, bucket, key, parallelUpload);

  return {
    size: stats.size,
    etag: result.ETag,
  };
}

/**
 * Like `uploadFile`, but for streaming (Task 8): takes a readable stream body (tar's stdout,
 * via a byte counter) instead of a file path, and returns the upload instead of awaiting it, so
 * the caller can race it against the archiving process and abort it on failure. Its `done()`
 * aborts a multipart upload that fails, the same way `uploadFile` does.
 * The sha256 is attached afterwards: a streamed archive's sha256 cannot be known before it
 * finishes. `metadata` goes with the create request, so it must be known at upload start.
 */
export function createStreamUpload(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  transfer?: UploadTransfer,
  options?: Pick<UploadOptions, 'ifNoneMatch' | 'tagging' | 'metadata'>
): StreamUpload {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      IfNoneMatch: options?.ifNoneMatch,
      Tagging: options?.tagging,
      Metadata: options?.metadata,
    },
    partSize: resolvePartSize(transfer),
    queueSize: resolveQueueSize(transfer),
    leavePartsOnError: false,
  });

  upload.on('httpUploadProgress', (progress) => {
    if (progress.total && progress.loaded) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      log.debug(`Upload progress: ${pct}% (${progress.loaded}/${progress.total} bytes)`);
    }
  });

  return {
    done: () => completeOrAbort(client, bucket, key, upload),
    abort: () => upload.abort(),
  };
}

/**
 * Encodes a CopySource header value: the bucket and each key segment percent-encoded, joined by
 * `/`. Per segment, so `#`, `?`, `&` and `%` in a key are escaped (encodeURI leaves them intact)
 * while the separators stay real separators.
 */
function encodeCopySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')].map(encodeURIComponent).join('/');
}

export interface ReplaceMetadataResult {
  /** The copied object's new ETag: the copy replaces the body, so the upload's ETag goes stale. */
  etag?: string;
}

/**
 * What makes a metadata copy fail rather than stamp this metadata onto another writer's body.
 * `ifMatch` (the ETag the save just wrote) fails the copy with 412. `versionId` pins the copy
 * source to the version the save just wrote, so a replaced object has no such source (404).
 */
export interface CopyGuard {
  ifMatch?: string;
  versionId?: string;
}

/**
 * Replaces an object's user metadata in place (S3 has no metadata-only update): a CopyObject
 * onto itself with MetadataDirective REPLACE. Tags are kept. Used after a streamed save, whose
 * sha256 is only known once the upload has finished. `guard` keeps the copy off another
 * writer's body. Only for objects up to 5 GiB: a larger one needs a multipart copy.
 */
export async function replaceObjectMetadata(
  client: S3Client,
  bucket: string,
  key: string,
  metadata: Record<string, string>,
  guard: CopyGuard = {}
): Promise<ReplaceMetadataResult> {
  const source = encodeCopySource(bucket, key);
  const result = await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource:
        guard.versionId === undefined
          ? source
          : `${source}?versionId=${encodeURIComponent(guard.versionId)}`,
      CopySourceIfMatch: guard.ifMatch,
      MetadataDirective: 'REPLACE',
      TaggingDirective: 'COPY',
      Metadata: metadata,
    })
  );
  return { etag: result.CopyObjectResult?.ETag };
}
