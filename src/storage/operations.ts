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
import * as core from '@actions/core';
import { Defaults } from '../constants';

export interface CacheObjectMetadata {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
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
  done(): Promise<{ ETag?: string }>;
  /** Stops the upload: `done()` rejects promptly, and no further parts are sent. */
  abort(): Promise<void>;
}

/**
 * Awaits `upload.done()`. When it rejects after a multipart upload was created, sends
 * AbortMultipartUpload for it before rethrowing the original error, unchanged.
 *
 * lib-storage aborts the multipart upload itself only when a part fails, the upload is aborted,
 * or the part count is wrong; not when CompleteMultipartUpload itself fails (a 412 from a lost
 * conditional-write race, or a 501 from a server that rejects `If-None-Match`). Without this,
 * every such failure leaves its uploaded parts behind, stored and billed until a lifecycle rule
 * removes them. When lib-storage has already aborted the upload, this second abort fails with
 * NoSuchUpload, which is expected and only logged at debug level.
 */
async function completeOrAbort(
  client: S3Client,
  bucket: string,
  key: string,
  upload: Upload
): Promise<{ ETag?: string }> {
  try {
    return await upload.done();
  } catch (err) {
    const uploadId = upload.uploadId;
    if (uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })
        );
        core.debug(`Aborted multipart upload ${uploadId} for s3://${bucket}/${key}.`);
      } catch (abortErr) {
        const error = abortErr as {
          name?: string;
          message?: string;
          $metadata?: { httpStatusCode?: number };
        };
        const message = `Could not abort multipart upload ${uploadId} for s3://${bucket}/${key}: ${error.message ?? String(abortErr)}`;
        if (error.name === 'NoSuchUpload' || error.$metadata?.httpStatusCode === 404) {
          core.debug(`${message} (it was already aborted).`);
        } else {
          core.warning(
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
  destinationPath: string
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
  const fileStream = fs.createReadStream(sourcePath);
  const partSize = resolvePartSize(transfer);

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
      core.debug(`Upload progress: ${pct}% (${progress.loaded}/${progress.total} bytes)`);
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
 * Metadata is attached afterwards by `replaceObjectMetadata`: a streamed archive's sha256 cannot
 * be known before it finishes.
 */
export function createStreamUpload(
  client: S3Client,
  bucket: string,
  key: string,
  body: Readable,
  transfer?: UploadTransfer,
  options?: Pick<UploadOptions, 'ifNoneMatch' | 'tagging'>
): StreamUpload {
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      IfNoneMatch: options?.ifNoneMatch,
      Tagging: options?.tagging,
    },
    partSize: resolvePartSize(transfer),
    queueSize: resolveQueueSize(transfer),
    leavePartsOnError: false,
  });

  upload.on('httpUploadProgress', (progress) => {
    if (progress.total && progress.loaded) {
      const pct = Math.round((progress.loaded / progress.total) * 100);
      core.debug(`Upload progress: ${pct}% (${progress.loaded}/${progress.total} bytes)`);
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
 * Replaces an object's user metadata in place (S3 has no metadata-only update): a CopyObject
 * onto itself with MetadataDirective REPLACE. Tags are kept. Used after a streamed save, whose
 * sha256 is only known once the upload has finished. `ifMatch` (the ETag the save just wrote)
 * makes the copy fail with 412 rather than stamp this metadata onto another writer's body.
 * Only for objects up to 5 GiB: a larger one needs a multipart copy.
 */
export async function replaceObjectMetadata(
  client: S3Client,
  bucket: string,
  key: string,
  metadata: Record<string, string>,
  ifMatch?: string
): Promise<ReplaceMetadataResult> {
  const result = await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: encodeCopySource(bucket, key),
      CopySourceIfMatch: ifMatch,
      MetadataDirective: 'REPLACE',
      TaggingDirective: 'COPY',
      Metadata: metadata,
    })
  );
  return { etag: result.CopyObjectResult?.ETag };
}
