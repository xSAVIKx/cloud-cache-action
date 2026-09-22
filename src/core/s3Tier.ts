import * as core from '@actions/core';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getCompressionConfig,
  type CompressionConfig,
  type CompressionMethod,
} from '../archive/compression';
import { createSha256Tap, sha256File } from '../archive/checksum';
import { getWorkspace, resolveCachePaths } from '../archive/paths';
import {
  buildCreateCommands,
  buildExtractCommands,
  createArchive,
  extractArchive,
  findTar,
  formatManifest,
  getArchiveSize,
  usesSeparateZstd,
  type TarTool,
} from '../archive/tar';
import {
  captureStderrTail,
  createByteCounter,
  killIfRunning,
  spawnArchiveCommand,
  waitForExit,
  waitForExitAfterKill,
} from '../archive/stream';
import { Defaults } from '../constants';
import { createStorageContext, type StorageContext } from '../storage/client';
import {
  checkObjectExists,
  createStreamUpload,
  downloadFile,
  findNewestObject,
  getObjectStream,
  getObjectTags,
  listObjects,
  putObjectTags,
  replaceObjectMetadata,
  uploadFile,
} from '../storage/operations';
import {
  downloadFileInParts,
  openObjectPartsStream,
  RangeNotSupportedError,
  shouldDownloadInParts,
  type PartDownloadOptions,
} from '../storage/parallelDownload';
import { isRetryableStreamError, withRetry } from '../storage/retry';
import { formatSize, isExactKeyMatch } from '../utils/inputUtils';
import { mapWithConcurrency } from '../utils/concurrency';
import type { CacheConfig } from './config';
import {
  encodeTagging,
  SHA256_METADATA_KEY,
  stripReservedMetadata,
  withChecksumTag,
  type ObjectTag,
} from './objectAttributes';
import { compileKeyTemplate, type KeyTemplate } from './keyTemplate';
import { toError, type RestoreOutcome, type SaveOutcome } from './outcomes';
import { resolveRefCandidates } from './refs';
import { computeCacheVersion } from './version';

/** Logged when streaming is requested but the plan needs the BSD-tar-plus-zstd two-step on Windows. */
const STREAMING_FALLBACK_MESSAGE =
  'Streaming is not supported with BSD tar and zstd on Windows; using a temporary archive file.';

/** Prefix listings sent at once while searching one ref. */
const LOOKUP_CONCURRENCY = 8;

export interface S3Tier {
  storage: StorageContext;
  template: KeyTemplate;
  /** Refs a restore searches, in order; [''] when caches are not scoped to a ref. */
  restoreRefs: readonly string[];
  /** Ref saves are written under; '' when caches are not scoped to a ref. */
  saveRef: string;
  compression: CompressionConfig;
  workspace: string;
  /** Extra attempts for download and upload streams, which the SDK does not retry itself. */
  streamRetries: number;
  /** Stream archives directly between tar and S3 instead of using a temporary file (Task 8). */
  streaming?: boolean;
  /** Ranged, parallel download settings; objects larger than `partSize` are fetched in parts. */
  download: DownloadSettings;
  /** Multipart upload settings: the part size and how many parts are in flight at once. */
  upload: UploadSettings;
  /** User metadata written on every save, next to the action's own sha256 entry. */
  metadata: Record<string, string>;
  /** Object tags written on every save, when the provider supports them. */
  tags: ObjectTag[];
  /** zstd or gzip level for saving; undefined keeps each method's own default. */
  compressionLevel?: number;
}

export interface DownloadSettings {
  /** Ranged GET requests in flight at once; 1 means one request for the whole object. */
  concurrency: number;
  /** Bytes per ranged GET request. */
  partSize: number;
}

export interface UploadSettings {
  /** Multipart parts in flight at once. */
  concurrency: number;
  /** Bytes per multipart part. */
  partSize: number;
}

export interface S3Match {
  matchedKey: string;
  exact: boolean;
  objectKey: string;
  size: number;
  etag?: string;
  ref: string;
}

export interface BuildS3TierOptions {
  /** Compression method the restore step used; detected again when absent or unknown. */
  compression?: string;
}

/** True when a failed conditional upload means another job already won the write. */
function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 412 || error.name === 'PreconditionFailed';
}

/**
 * True when a conditional upload hit a 409 ConditionalRequestConflict: a concurrent write or
 * delete of the same key (a parallel prune, for example) landed while it was in progress. Worth
 * one more attempt with the same condition.
 */
function isConditionalConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 409 || error.name === 'ConditionalRequestConflict';
}

const CONDITION_REJECTED_NAMES = new Set(['NotImplemented', 'NotSupported', 'InvalidArgument']);

/** True when the server rejected the `If-None-Match` header itself, rather than the condition. */
function isConditionUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (error.$metadata?.httpStatusCode === 501) {
    return true;
  }
  return (
    error.name !== undefined &&
    CONDITION_REJECTED_NAMES.has(error.name) &&
    /if-none-match/i.test(error.message ?? '')
  );
}

/** How the rejected tagging request reads in the warning: its error name, else its message. */
function taggingRejection(err: unknown): string {
  if (typeof err !== 'object' || err === null) {
    return String(err);
  }
  const error = err as { name?: string; message?: string };
  const name = error.name !== undefined && error.name !== 'Error' ? error.name : '';
  return name || error.message || 'unknown error';
}

/**
 * Records that this context's server cannot store object tags, so later uploads omit them, and
 * warns about it once per run, naming what the server answered. Only called once a tag-free
 * upload has actually succeeded.
 */
function noteObjectTaggingUnsupported(tier: S3Tier, bucket: string, err: unknown): void {
  if (!tier.storage.objectTaggingUnsupported) {
    core.warning(
      `s3://${bucket} could not store object tags (${taggingRejection(err)}); saved without them.`
    );
  }
  tier.storage.objectTaggingUnsupported = true;
}

/** True when the server rejected the request because it does not implement object tagging. */
export function isTaggingUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const message = (error.message ?? '').toLowerCase();
  return (
    error.name === 'NotImplemented' ||
    error.$metadata?.httpStatusCode === 501 ||
    message.includes('tagging') ||
    message.includes('x-amz-tagging')
  );
}

const COMPRESSION_CONFIGS: Record<CompressionMethod, CompressionConfig> = {
  zstd: { method: 'zstd', archiveFilename: Defaults.DefaultArchiveFilenameZstd },
  gzip: { method: 'gzip', archiveFilename: Defaults.DefaultArchiveFilenameGzip },
};

async function resolveCompression(persisted: string | undefined): Promise<CompressionConfig> {
  if (persisted === 'zstd' || persisted === 'gzip') {
    core.debug(`Using the ${persisted} compression the restore step used.`);
    return COMPRESSION_CONFIGS[persisted];
  }
  return getCompressionConfig();
}

export async function buildS3Tier(
  config: CacheConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: BuildS3TierOptions = {}
): Promise<S3Tier> {
  const storage = createStorageContext({
    maxAttempts: config.retryEnabled ? config.retryCount + 1 : 1,
  });
  const compression = await resolveCompression(options.compression);
  const refs = resolveRefCandidates(env);
  const scopedToRef = config.scopedToRef && refs.current !== undefined;
  if (config.scopedToRef && !scopedToRef) {
    core.debug('GITHUB_REF is not set, so caches are not scoped to a ref.');
  }

  const template = compileKeyTemplate({
    pattern: config.s3KeyPattern,
    repository: env.GITHUB_REPOSITORY ?? '',
    prefix: config.prefix,
    scopedToRepository: config.scopedToRepository,
    scopedToRef,
    version: computeCacheVersion(config.paths, compression.method, config.enableCrossOsArchive),
    archiveFilename: compression.archiveFilename,
    env,
  });
  for (const warning of template.warnings) {
    core.warning(warning);
  }
  // A pattern without ${ref} gives every ref the same object keys; search them only once.
  const usesRef = scopedToRef && template.objectKey('a', '') !== template.objectKey('b', '');
  const compressionLevel = clampCompressionLevel(config.compressionLevel, compression.method);

  return {
    storage,
    template,
    restoreRefs: usesRef ? refs.restore : [''],
    saveRef: usesRef ? (refs.current as string) : '',
    compression,
    workspace: getWorkspace(env),
    streamRetries: config.retryEnabled ? config.retryCount : 0,
    streaming: config.streaming,
    download: { concurrency: config.downloadConcurrency, partSize: config.downloadChunkSize },
    upload: {
      concurrency: config.uploadConcurrency,
      partSize: config.uploadChunkSize ?? Defaults.DefaultUploadChunkSize,
    },
    metadata: config.metadata,
    tags: config.tags,
    compressionLevel,
  };
}

/** gzip stops at 9, so a higher level warns once and uses 9. */
function clampCompressionLevel(
  level: number | undefined,
  method: CompressionMethod
): number | undefined {
  if (level === undefined || method !== 'gzip' || level <= Defaults.MaxGzipCompressionLevel) {
    return level;
  }
  core.warning(
    `Input "compression-level" is ${level}, above gzip's maximum of ${Defaults.MaxGzipCompressionLevel}; using ${Defaults.MaxGzipCompressionLevel}.`
  );
  return Defaults.MaxGzipCompressionLevel;
}

/** One object under a search prefix, with what the template makes of it. */
export interface Candidate {
  objectKey: string;
  /** The cache key the object carries, or undefined when it does not fit the pattern. */
  key?: string;
  /** The `${version}` the object carries, or undefined when it does not fit the pattern. */
  version?: string;
  size: number;
  lastModified?: Date;
  /** True when the template accepts the object: same key pattern, version and archive format. */
  accepted: boolean;
}

/**
 * Every object under the listing prefix for `ref` and `keyPrefix`, accepted or not, in the order
 * the server lists them. `findS3Match` takes the newest accepted one; the explain report shows
 * them all, with the version each carries, to say why they were rejected.
 */
export async function listCandidates(
  tier: S3Tier,
  ref: string,
  keyPrefix: string
): Promise<Candidate[]> {
  const { client, bucket } = tier.storage;
  const prefix = tier.template.searchPrefix(ref, keyPrefix);
  core.debug(`Listing s3://${bucket}/${prefix}`);
  const objects = await listObjects(client, bucket, prefix);
  return objects.map((object) => {
    const key = tier.template.extractKey(ref, object.key);
    return {
      objectKey: object.key,
      key,
      version: tier.template.extractVersion(ref, object.key),
      size: object.size,
      lastModified: object.lastModified,
      accepted: key !== undefined,
    };
  });
}

/**
 * For each ref in order: the exact key, then the primary key as a prefix, then each restore
 * key as a prefix, taking the newest object for a prefix. Only objects the template accepts
 * (same version and archive format) count. The first hit wins.
 */
export async function findS3Match(
  tier: S3Tier,
  primaryKey: string,
  restoreKeys: readonly string[]
): Promise<S3Match | undefined> {
  const { client, bucket } = tier.storage;
  const keyPrefixes = [primaryKey, ...restoreKeys];

  // Refs stay sequential: a prefix match on an earlier ref outranks an exact match on a later one,
  // so a later ref may only be searched once this one has produced nothing.
  for (const ref of tier.restoreRefs) {
    const exactKey = tier.template.objectKey(ref, primaryKey);
    core.debug(`Checking s3://${bucket}/${exactKey}`);
    const exact = await checkObjectExists(client, bucket, exactKey);
    if (exact) {
      return {
        matchedKey: primaryKey,
        exact: true,
        objectKey: exactKey,
        size: exact.size,
        etag: exact.etag,
        ref,
      };
    }

    for (const keyPrefix of keyPrefixes) {
      core.debug(`Listing s3://${bucket}/${tier.template.searchPrefix(ref, keyPrefix)}`);
    }
    const listed = await mapWithConcurrency(keyPrefixes, LOOKUP_CONCURRENCY, (keyPrefix) =>
      findNewestObject(
        client,
        bucket,
        tier.template.searchPrefix(ref, keyPrefix),
        (objectKey) => tier.template.extractKey(ref, objectKey) !== undefined
      )
    );

    // Resolved in key order, never in the order the responses arrived.
    for (const newest of listed) {
      if (newest) {
        const matchedKey = tier.template.extractKey(ref, newest.key) as string;
        return {
          matchedKey,
          exact: isExactKeyMatch(primaryKey, matchedKey),
          objectKey: newest.key,
          size: newest.size,
          etag: newest.etag,
          ref,
        };
      }
    }
  }
  return undefined;
}

/**
 * The expected sha256 for an object: metadata first, because every object written before tagging
 * carries it there, then the reserved tag — unless the response said outright that the object has
 * no tags (`tagCount === 0`), which costs no extra request. A provider that just does not report
 * the count on GetObject (`tagCount === undefined`, seen on RustFS) still gets the tag read: an
 * unknown count is not proof of absence, and skipping it there would silently defeat the check.
 */
async function resolveExpectedSha256(
  tier: S3Tier,
  objectKey: string,
  metadata: Record<string, string> | undefined,
  tagCount: number | undefined
): Promise<string | undefined> {
  const fromMetadata = metadata?.[SHA256_METADATA_KEY];
  if (fromMetadata) {
    return fromMetadata;
  }
  if (tagCount === 0) {
    return undefined;
  }
  try {
    const tags = await getObjectTags(tier.storage.client, tier.storage.bucket, objectKey);
    return tags[SHA256_METADATA_KEY];
  } catch (err) {
    core.debug(
      `Could not read the tags of s3://${tier.storage.bucket}/${objectKey}: ${toError(err).message}`
    );
    return undefined;
  }
}

export async function restoreFromS3(
  tier: S3Tier,
  primaryKey: string,
  restoreKeys: readonly string[],
  lookupOnly: boolean
): Promise<RestoreOutcome> {
  let match: S3Match | undefined;
  try {
    match = await findS3Match(tier, primaryKey, restoreKeys);
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
  if (!match) {
    return { kind: 'miss' };
  }

  const found = match;
  const hit: RestoreOutcome = {
    kind: 'hit',
    matchedKey: found.matchedKey,
    exact: found.exact,
    s3: { objectKey: found.objectKey, size: found.size, etag: found.etag },
  };
  if (lookupOnly) {
    return hit;
  }
  const recordDownload = (parts: number, transferStart: number): void => {
    hit.transferMs = Date.now() - transferStart;
    hit.downloadParts = parts;
  };
  const where = found.ref ? ` on ${found.ref}` : '';
  core.info(
    `S3 cache ${found.exact ? 'hit' : 'partial hit'} for key "${found.matchedKey}"${where} (${formatSize(found.size)})`
  );

  if (tier.streaming) {
    try {
      const tar = await findTar();
      if (
        !usesSeparateZstd({
          tar,
          platform: process.platform,
          compression: tier.compression.method,
        })
      ) {
        return await restoreFromS3Streaming(tier, found, tar, hit);
      }
      core.info(STREAMING_FALLBACK_MESSAGE);
    } catch (err) {
      return { kind: 'error', error: toError(err) };
    }
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-restore-'));
  try {
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    const { bucket } = tier.storage;
    const transferStart = Date.now();
    const { metadata, tagCount, parts } = await downloadArchive(tier, found, archivePath);
    recordDownload(parts, transferStart);
    const expectedSha256 = await resolveExpectedSha256(tier, found.objectKey, metadata, tagCount);
    if (expectedSha256) {
      const actualSha256 = await sha256File(archivePath);
      if (actualSha256 !== expectedSha256) {
        return {
          kind: 'error',
          error: new Error(
            `Integrity check failed for s3://${bucket}/${found.objectKey}: expected sha256 ${expectedSha256}, got ${actualSha256}`
          ),
        };
      }
    } else {
      core.debug(
        `s3://${bucket}/${found.objectKey} has no ${SHA256_METADATA_KEY} metadata; skipping integrity check.`
      );
    }
    await extractArchive(archivePath, tier.compression, tier.workspace);
    if (hit.kind === 'hit' && hit.s3) {
      hit.s3.metadata = stripReservedMetadata(metadata);
    }
    return hit;
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function saveToS3(
  tier: S3Tier,
  primaryKey: string,
  patterns: readonly string[]
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const objectKey = tier.template.objectKey(tier.saveRef, primaryKey);
  try {
    const existing = await checkObjectExists(client, bucket, objectKey);
    if (existing) {
      core.info(`Cache already exists at s3://${bucket}/${objectKey}; not uploading it again.`);
      return { kind: 'exists', s3: { objectKey, size: existing.size, etag: existing.etag } };
    }

    const { entries } = await resolveCachePaths(patterns, tier.workspace);
    if (entries.length === 0) {
      core.warning(
        'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.'
      );
      return { kind: 'skipped', reason: 'no paths matched' };
    }

    if (tier.streaming) {
      const tar = await findTar();
      if (
        !usesSeparateZstd({ tar, platform: process.platform, compression: tier.compression.method })
      ) {
        return await saveToS3Streaming(tier, objectKey, entries, tar, primaryKey);
      }
      core.info(STREAMING_FALLBACK_MESSAGE);
    }

    return await saveToS3FileMode(tier, objectKey, entries, primaryKey);
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  }
}

/**
 * File-based save: archives to a temporary file, uploads it, and handles the Task 4 conditional
 * write outcomes (412 -> exists; a 409 conflict is retried once with the same condition; a
 * condition the server rejects outright is retried once without it). Used both as the default
 * (non-streaming) save path, and as the fallback a streaming save takes when its server rejects
 * `If-None-Match` outright or its conditional write conflicts (see `saveToS3Streaming`) — reused
 * rather than duplicated, so both paths agree on precondition handling. `retryConflict: false`
 * is passed by that 409 fallback, which already is the one retry, and `omitTags: true` by the
 * fallback a streamed tagged upload takes, which must not send tags again without latching the
 * tier-wide flag first.
 */
async function saveToS3FileMode(
  tier: S3Tier,
  objectKey: string,
  entries: readonly string[],
  primaryKey: string,
  retryConflict = true,
  omitTags = false
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
  try {
    const archivePath = path.join(tempDir, tier.compression.archiveFilename);
    await createArchive(
      archivePath,
      entries,
      tier.compression,
      tier.workspace,
      tier.compressionLevel
    );
    const archiveSize = getArchiveSize(archivePath);
    core.info(`Uploading ${formatSize(archiveSize)} to s3://${bucket}/${objectKey}...`);
    const checksum = await sha256File(archivePath);
    const metadata = { ...tier.metadata, [SHA256_METADATA_KEY]: checksum };
    const attemptUpload = (ifNoneMatch: string | undefined, tagging: string | undefined) =>
      withRetry(
        () =>
          uploadFile(client, bucket, objectKey, archivePath, tier.upload, {
            metadata,
            ifNoneMatch,
            tagging,
          }),
        {
          retries: tier.streamRetries,
          operationName: `Upload of ${objectKey}`,
          shouldRetry: isRetryableStreamError,
        }
      );

    const transferStart = Date.now();
    const transferMs = (): number => Date.now() - transferStart;
    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    const attemptConditionalUpload = async (tagging: string | undefined) => {
      try {
        return await attemptUpload('*', tagging);
      } catch (err) {
        if (!retryConflict || !isConditionalConflict(err)) {
          throw err;
        }
        core.info(
          `A concurrent write to s3://${bucket}/${objectKey} conflicted with this upload; retrying it once.`
        );
        return await attemptUpload('*', tagging);
      }
    };
    const uploadWith = (tagging: string | undefined) =>
      sendCondition ? attemptConditionalUpload(tagging) : attemptUpload(undefined, tagging);
    // Omitted upfront once this context's server has told us it cannot store tags, and when the
    // caller (a streaming save whose tagged upload was rejected) asks for a tag-free retry.
    const tagging =
      tier.storage.objectTaggingUnsupported || omitTags ? undefined : encodeTagging(tier.tags);
    try {
      let uploaded: { size: number; etag?: string };
      try {
        uploaded = await uploadWith(tagging);
      } catch (err) {
        // Checked before the condition outcomes below, and only for a request that carried a
        // `Tagging` header: a provider without tagging support answers the same 501 NotImplemented
        // an unsupported `If-None-Match` does.
        if (tagging === undefined || !isTaggingUnsupported(err)) {
          throw err;
        }
        // Only a retry that actually succeeds without tags proves the tags were the problem. When
        // it fails too, the flag stays unset and the error goes to the 412/501/409 handling below,
        // whose unconditional retry sends the tags again — the 501 was about `If-None-Match`.
        uploaded = await uploadWith(undefined);
        noteObjectTaggingUnsupported(tier, bucket, err);
      }
      core.info(`Cache saved to S3 with key: ${primaryKey}`);
      return {
        kind: 'saved',
        s3: { objectKey, size: uploaded.size, etag: uploaded.etag },
        transferMs: transferMs(),
      };
    } catch (err) {
      if (sendCondition && isPreconditionFailed(err)) {
        core.info(`Another job saved s3://${bucket}/${objectKey} first; keeping its cache.`);
        return {
          kind: 'exists',
          s3: { objectKey, size: archiveSize, etag: undefined },
          transferMs: transferMs(),
        };
      }
      if (sendCondition && isConditionUnsupported(err)) {
        core.debug(
          `s3://${bucket} rejected the If-None-Match condition; retrying the upload of ${objectKey} without it.`
        );
        tier.storage.conditionalWriteUnsupported = true;
        const uploaded = await attemptUpload(
          undefined,
          tier.storage.objectTaggingUnsupported ? undefined : tagging
        );
        core.info(`Cache saved to S3 with key: ${primaryKey}`);
        return {
          kind: 'saved',
          s3: { objectKey, size: uploaded.size, etag: uploaded.etag },
          transferMs: transferMs(),
        };
      }
      throw err;
    }
  } catch (err) {
    return { kind: 'error', error: toError(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** A single CopyObject can only copy up to 5 GiB; a larger object would need a multipart copy. */
const MAX_COPY_SIZE = 5 * 1024 * 1024 * 1024;

/**
 * Attaches a streamed save's sha256 and user metadata once the upload has finished, the only
 * point at which the digest is known: a CopyObject onto the object itself. Best-effort — the
 * cache is already saved, so a provider that cannot do this copy (or an archive too large for
 * one) costs the metadata and warns once, never the save. Returns the ETag to report: the copy
 * rewrites the object, so its ETag supersedes the upload's; on any failure the upload's stands.
 */
async function attachStreamedMetadataByCopy(
  tier: S3Tier,
  objectKey: string,
  sha256: string,
  size: number,
  uploadedEtag: string | undefined
): Promise<string | undefined> {
  const { client, bucket } = tier.storage;
  if (size > MAX_COPY_SIZE) {
    core.warning(
      `Saved s3://${bucket}/${objectKey} but could not attach metadata: archives over 5 GiB cannot be copied in one request.`
    );
    return uploadedEtag;
  }
  try {
    // `CopySourceIfMatch`, when the upload reported an ETag: a concurrent writer that replaced
    // the object between the upload and this copy must not get this save's metadata stamped onto
    // its body. The 412 that then comes back is handled like any other copy failure.
    const metadata = { ...tier.metadata, [SHA256_METADATA_KEY]: sha256 };
    const copied = await withRetry(
      () => replaceObjectMetadata(client, bucket, objectKey, metadata, uploadedEtag),
      {
        retries: tier.streamRetries,
        operationName: `Metadata for ${objectKey}`,
        shouldRetry: isRetryableStreamError,
      }
    );
    return copied.etag ?? uploadedEtag;
  } catch (err) {
    core.warning(
      `Saved s3://${bucket}/${objectKey} but could not attach metadata: ${toError(err).message}`
    );
    return uploadedEtag;
  }
}

/**
 * True when the server answered a `PutObjectTagging` request that it does not implement the
 * tagging API at all. Deliberately narrower than `isTaggingUnsupported` above: that predicate
 * also treats any message mentioning "tagging" as unsupported, which is the right call for an
 * upload's `Tagging` header (a provider that rejects it tends to say so in those words) but far
 * too broad here — an `AccessDenied` for the `s3:PutObjectTagging` permission also mentions
 * tagging, and must not latch `objectTaggingUnsupported`, which would silently drop the user's
 * own tags from every later upload in the run for a reason that had nothing to do with support.
 */
function isTagPutUnsupported(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error.$metadata?.httpStatusCode === 501 || error.name === 'NotImplemented';
}

/**
 * Attaches the checksum to a streamed object. A tag rewrites no data, so it costs a fraction of
 * the copy on a large archive, but it is only safe when this job provably owns the object, which
 * means the upload carried an honoured `If-None-Match`. Everything else — user metadata
 * configured (which a tag cannot carry), a provider already known not to support tagging, or an
 * upload that did not use the condition — keeps the ETag-guarded copy.
 */
async function attachStreamedChecksum(
  tier: S3Tier,
  objectKey: string,
  sha256: string,
  size: number,
  uploadedEtag: string | undefined,
  usedCondition: boolean
): Promise<string | undefined> {
  const { client, bucket } = tier.storage;
  const canTag =
    usedCondition &&
    !tier.storage.objectTaggingUnsupported &&
    Object.keys(tier.metadata).length === 0;

  if (canTag) {
    try {
      await putObjectTags(client, bucket, objectKey, withChecksumTag(tier.tags, sha256));
      return uploadedEtag;
    } catch (err) {
      if (isTagPutUnsupported(err)) {
        tier.storage.objectTaggingUnsupported = true;
        core.debug(
          `s3://${bucket} has no object tagging API; attaching the checksum by copy instead.`
        );
      } else {
        core.debug(`Could not tag s3://${bucket}/${objectKey}: ${toError(err).message}`);
      }
    }
  }

  return await attachStreamedMetadataByCopy(tier, objectKey, sha256, size, uploadedEtag);
}

/** Wraps a failure with tar's recent stderr output, for a clearer error message. */
function withStderrTail(err: unknown, tail: readonly string[]): Error {
  const base = toError(err);
  if (tail.length === 0) {
    return base;
  }
  return new Error(`${base.message}\n${tail.join('\n')}`, { cause: base });
}

/**
 * Streaming save (Task 8): spawns tar writing the archive to stdout and pipes it, through a
 * sha256 tap and a byte counter (there is no file to hash or stat for the size), into an S3
 * multipart upload. The sha256 and the user metadata are attached afterwards, best-effort, by a
 * CopyObject onto the saved object. Tar and
 * the upload run concurrently, but the upload body is only ever told the archive is complete
 * (`counter.stream.end()`) once tar has actually closed with exit code 0; any other outcome —
 * a non-zero exit, a signal, or the pipe itself breaking — destroys the body with an error
 * first, so lib-storage can never send the final PutObject/CompleteMultipartUpload for a
 * truncated archive. `If-None-Match` would otherwise keep such a bad object forever.
 */
async function saveToS3Streaming(
  tier: S3Tier,
  objectKey: string,
  entries: readonly string[],
  tar: TarTool,
  primaryKey: string
): Promise<SaveOutcome> {
  const { client, bucket } = tier.storage;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-cache-save-'));
  let child: ChildProcess | undefined;
  let tarClose: Promise<number> | undefined;
  // Set once the inner catch below has killed tar and waited for it, so the outer catch (which
  // its rethrow also reaches) does not wait a second time.
  let tarReaped = false;
  try {
    const manifestPath = path.join(tempDir, 'manifest.txt');
    fs.writeFileSync(manifestPath, formatManifest(entries));
    const [command] = buildCreateCommands({
      tar,
      platform: process.platform,
      compression: tier.compression.method,
      archivePath: '-',
      workspace: tier.workspace,
      tempDir,
      manifestPath,
      level: tier.compressionLevel,
    });

    child = spawnArchiveCommand(command, ['ignore', 'pipe', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    tarClose = waitForExit(child);
    const counter = createByteCounter();
    // Hashes the archive as it streams past, so the sha256 a restore verifies is known once the
    // upload finishes (there is no file to hash afterwards).
    const tap = createSha256Tap();
    // A stream this code may `destroy(err)` itself (below) needs a permanent error listener:
    // pipeline's own listener is only attached while it is in flight, and is gone by the time
    // finalizeBody calls destroy() after pipeline has already settled.
    counter.stream.on('error', () => undefined);
    // `end: false`: tar's stdout reaching EOF must never by itself end the upload body — only a
    // confirmed clean exit (below) may do that.
    // The tap goes first so `end: false` — which `pipeline` applies to the last stream only —
    // still governs the upload body alone: the tap is ended by tar's stdout reaching EOF (which
    // is what finalizes its digest), while `counter.stream` stays under the explicit end below.
    const pipePromise = pipeline(child.stdout as Readable, tap.stream, counter.stream, {
      end: false,
    });

    // Captured once and reused (not re-invoked) so every branch below can await the same
    // settlement, whichever of upload.done()/finalizeBody() the outer Promise.all resolved on.
    const finalized = (async (): Promise<void> => {
      let code: number;
      try {
        [, code] = await Promise.all([pipePromise, tarClose]);
      } catch (err) {
        counter.stream.destroy(toError(err));
        throw err;
      }
      if (code !== 0) {
        const failure = new Error(`tar exited with code ${code}`);
        counter.stream.destroy(failure);
        throw failure;
      }
      counter.stream.end();
    })();
    // Keeps `finalized` "handled" from Node's perspective even if nothing below ever awaits it
    // (a synchronous throw between here and the inner try, e.g. from createStreamUpload, would
    // otherwise leave its eventual rejection unhandled, which is fatal on Node 24). The `finalized`
    // binding itself is untouched, so the real await below still observes its outcome.
    finalized.catch(() => undefined);

    const sendCondition = !tier.storage.conditionalWriteUnsupported;
    const transferStart = Date.now();
    core.info(`Streaming upload to s3://${bucket}/${objectKey}...`);
    const tagging = tier.storage.objectTaggingUnsupported ? undefined : encodeTagging(tier.tags);
    const upload = createStreamUpload(client, bucket, objectKey, counter.stream, tier.upload, {
      ifNoneMatch: sendCondition ? '*' : undefined,
      tagging,
    });

    // Captured once so the failure path below can wait for it to settle.
    const uploadDone = upload.done();
    try {
      const [uploaded] = await Promise.all([uploadDone, finalized]);
      core.info(`Cache saved to S3 with key: ${primaryKey}`);
      const size = counter.count();
      const transferMs = Date.now() - transferStart;
      const etag = await attachStreamedChecksum(
        tier,
        objectKey,
        tap.digest(),
        size,
        uploaded.ETag,
        sendCondition
      );
      return { kind: 'saved', s3: { objectKey, size, etag }, transferMs };
    } catch (err) {
      // Fail the body first. When the upload stopped reading it, tar's stdout is paused with data
      // still buffered, so it never closes and tar's close never fires; destroying the body makes
      // pipeline destroy that stdout too. (When tar failed first, finalized already did this.)
      counter.stream.destroy(toError(err));
      // Kill tar before any network wait below, so a hung tar never outlives a slow abort request.
      killIfRunning(child);
      // When tar failed first, the upload may still be running: stop it, then wait for done()
      // to settle, which is where a multipart upload it created gets aborted (see
      // createStreamUpload). abort() makes done() reject promptly, so this wait is short; when
      // done() already rejected, it has already sent the abort and this does nothing.
      await upload.abort().catch(() => undefined);
      await uploadDone.catch(() => undefined);
      // Kill tar again (a no-op when it has exited), then wait, bounded, for it to close,
      // so no failure mode can block this step indefinitely. Wait on tar's own close, not on
      // finalized: once the pipe has failed, finalized rejects while tar may still be alive,
      // and the temp directory must not be removed under a live tar. Only after this do we read
      // the byte count or the final stderr tail below.
      await waitForExitAfterKill(child, tarClose);
      tarReaped = true;
      // Before the condition outcomes below, and only for a request that carried a `Tagging`
      // header: a provider without tagging support answers the same 501 an unsupported
      // `If-None-Match` does. A streamed body cannot be replayed, so the retry without tags is a
      // file-mode save, which omits them once the flag below is set.
      if (tagging !== undefined && isTaggingUnsupported(err)) {
        const outcome = await saveToS3FileMode(tier, objectKey, entries, primaryKey, true, true);
        // Only a save that actually succeeded without tags proves the tags were the problem; the
        // same 501 also means an unsupported `If-None-Match`, which that save handles itself.
        if (outcome.kind === 'saved') {
          noteObjectTaggingUnsupported(tier, bucket, err);
        }
        return outcome;
      }
      if (sendCondition && isPreconditionFailed(err)) {
        core.info(`Another job saved s3://${bucket}/${objectKey} first; keeping its cache.`);
        return {
          kind: 'exists',
          s3: { objectKey, size: counter.count(), etag: undefined },
          transferMs: Date.now() - transferStart,
        };
      }
      if (sendCondition && isConditionUnsupported(err)) {
        core.debug(
          `s3://${bucket} rejected the If-None-Match condition; retrying the upload of ${objectKey} without it.`
        );
        tier.storage.conditionalWriteUnsupported = true;
        return await saveToS3FileMode(tier, objectKey, entries, primaryKey);
      }
      if (sendCondition && isConditionalConflict(err)) {
        // A streamed body cannot be replayed, so the one retry is a file-mode save, which keeps
        // the condition.
        core.info(
          `A concurrent write to s3://${bucket}/${objectKey} conflicted with this upload; retrying it once from a temporary archive file.`
        );
        return await saveToS3FileMode(tier, objectKey, entries, primaryKey, false);
      }
      throw withStderrTail(err, stderrTail.lines());
    }
  } catch (err) {
    // Reached by the inner catch's rethrow, which has already killed tar and waited for it, and
    // by a failure before the inner try took charge of tar (createStreamUpload throwing, for
    // example). Only the latter still has tar to stop: destroy its stdout, which nothing may be
    // reading, so its close can fire, then kill it and wait, bounded, before removing tempDir.
    if (child && !tarReaped) {
      child.stdout?.destroy();
      if (tarClose) {
        await waitForExitAfterKill(child, tarClose);
      } else {
        killIfRunning(child);
      }
    }
    return { kind: 'error', error: toError(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Part settings for one object, or undefined when it should be fetched in a single request. */
function partPlan(tier: S3Tier, found: S3Match): PartDownloadOptions | undefined {
  const { concurrency, partSize } = tier.download;
  if (concurrency <= 1 || !shouldDownloadInParts(found.size, partSize)) {
    return undefined;
  }
  const parts = Math.ceil(found.size / partSize);
  core.info(
    `Downloading ${formatSize(found.size)} in ${parts} parts of ${formatSize(partSize)}, ${Math.min(concurrency, parts)} at a time`
  );
  return { size: found.size, partSize, concurrency, retries: tier.streamRetries };
}

/** Logged once when a provider answers a ranged GET with the whole object. */
function logRangeFallback(tier: S3Tier, found: S3Match): void {
  core.info(
    `s3://${tier.storage.bucket}/${found.objectKey} does not support ranged GET requests; downloading it in one request.`
  );
}

/**
 * Downloads the archive to `archivePath`: in concurrent ranged parts when the object is large
 * enough and the settings allow, otherwise in one request retried as a whole. A provider that
 * ignores `Range` gets the single request, which is what it would have served anyway.
 */
async function downloadArchive(
  tier: S3Tier,
  found: S3Match,
  archivePath: string
): Promise<{ metadata?: Record<string, string>; tagCount?: number; parts: number }> {
  const { client, bucket } = tier.storage;
  const plan = partPlan(tier, found);
  if (plan) {
    try {
      return await downloadFileInParts(client, bucket, found.objectKey, archivePath, plan);
    } catch (err) {
      if (!(err instanceof RangeNotSupportedError)) {
        throw err;
      }
      logRangeFallback(tier, found);
    }
  }
  const { metadata, tagCount } = await withRetry(
    () => downloadFile(client, bucket, found.objectKey, archivePath),
    {
      retries: tier.streamRetries,
      operationName: `Download of ${found.objectKey}`,
      shouldRetry: isRetryableStreamError,
    }
  );
  return { metadata, tagCount, parts: 1 };
}

/** The streaming counterpart of `downloadArchive`: the archive bytes as one ordered stream. */
async function openArchiveStream(
  tier: S3Tier,
  found: S3Match
): Promise<{
  body: Readable;
  metadata?: Record<string, string>;
  tagCount?: number;
  parts: number;
}> {
  const { client, bucket } = tier.storage;
  const plan = partPlan(tier, found);
  if (plan) {
    try {
      return await openObjectPartsStream(client, bucket, found.objectKey, plan);
    } catch (err) {
      if (!(err instanceof RangeNotSupportedError)) {
        throw err;
      }
      logRangeFallback(tier, found);
    }
  }
  const stream = await getObjectStream(client, bucket, found.objectKey);
  return { body: stream.body, metadata: stream.metadata, tagCount: stream.tagCount, parts: 1 };
}
/**
 * Streaming restore (Task 8): pipes the GetObject body through the sha256 tap into a spawned
 * tar extract reading from stdin, so nothing touches disk except the extracted files themselves.
 */
async function restoreFromS3Streaming(
  tier: S3Tier,
  found: S3Match,
  tar: TarTool,
  hit: RestoreOutcome
): Promise<RestoreOutcome> {
  const { bucket } = tier.storage;
  let body: Readable | undefined;
  let child: ChildProcess | undefined;
  let tarClose: Promise<number> | undefined;
  // Set once the inner catch below has killed tar and waited for it, so the outer catch (which
  // its rethrow also reaches) does not wait a second time.
  let tarReaped = false;
  const transferStart = Date.now();
  try {
    const stream = await openArchiveStream(tier, found);
    body = stream.body;
    const { metadata, tagCount } = stream;
    fs.mkdirSync(tier.workspace, { recursive: true });
    const [command] = buildExtractCommands({
      tar,
      platform: process.platform,
      compression: tier.compression.method,
      archivePath: '-',
      workspace: tier.workspace,
      tempDir: os.tmpdir(),
    });

    child = spawnArchiveCommand(command, ['pipe', 'ignore', 'pipe']);
    const stderrTail = captureStderrTail(child.stderr);
    tarClose = waitForExit(child);
    // Keeps `tarClose` "handled" from Node's perspective if a synchronous throw below (from
    // createSha256Tap or the pipeline() call itself) reaches the outer catch before the
    // Promise.all below ever attaches its own handler to it.
    tarClose.catch(() => undefined);
    const tap = createSha256Tap();
    const pipePromise = pipeline(body, tap.stream, child.stdin as Writable);

    try {
      const [, code] = await Promise.all([pipePromise, tarClose]);
      if (code !== 0) {
        throw new Error(`tar exited with code ${code}`);
      }
      if (hit.kind === 'hit') {
        hit.transferMs = Date.now() - transferStart;
        hit.downloadParts = stream.parts;
      }
    } catch (err) {
      // tar's stdout is ignored and its stderr is always being read, so a killed tar closes
      // promptly (unlike the save side, nothing here can hold its close back): wait for that
      // before reading the final stderr tail.
      await waitForExitAfterKill(child, tarClose);
      tarReaped = true;
      throw withStderrTail(err, stderrTail.lines());
    }

    const expectedSha256 = await resolveExpectedSha256(tier, found.objectKey, metadata, tagCount);
    if (expectedSha256) {
      const actualSha256 = tap.digest();
      if (actualSha256 !== expectedSha256) {
        return {
          kind: 'error',
          error: new Error(
            `Integrity check failed for s3://${bucket}/${found.objectKey}: expected sha256 ${expectedSha256}, got ${actualSha256}; files may already have been extracted`
          ),
        };
      }
    } else {
      core.debug(
        `s3://${bucket}/${found.objectKey} has no ${SHA256_METADATA_KEY} metadata; skipping integrity check.`
      );
    }
    if (hit.kind === 'hit' && hit.s3) {
      hit.s3.metadata = stripReservedMetadata(metadata);
    }
    return hit;
  } catch (err) {
    // Reached by the inner catch's rethrow (a failed download, pipe or tar, with tar already
    // killed and waited for there), and by any failure before the inner try took charge: the
    // GetObject request failing, or a throw before or right after spawning tar, before the
    // pipeline started. In the latter case stop tar here: release its stdin, kill it and wait,
    // bounded, for it to close. Either way release the GetObject body, so its connection is
    // never left dangling. The workspace may already hold partly extracted files.
    if (child && !tarReaped) {
      child.stdin?.destroy();
      if (tarClose) {
        await waitForExitAfterKill(child, tarClose);
      } else {
        killIfRunning(child);
      }
    }
    body?.destroy();
    return { kind: 'error', error: toError(err) };
  }
}
