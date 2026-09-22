import * as core from '@actions/core';
import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { formatSize } from '../utils/inputUtils';
import { mapWithConcurrency } from '../utils/concurrency';
import type { KeyTemplate, ScopeProblem } from './keyTemplate';
import { toError } from './outcomes';
import type { StorageContext } from '../storage/client';

export interface PruneOptions {
  /** Delete archives whose LastModified is older than this many days. Must be > 0. */
  olderThanDays: number;
  /** Prune only this ref; every ref when omitted. */
  ref?: string;
  /** List candidates without deleting anything. */
  dryRun: boolean;
  /** Reference instant the age cutoff is computed from; defaults to `new Date()`. For tests. */
  now?: Date;
  /** Deletions in flight at once. Defaults to 8. */
  concurrency?: number;
}

export interface PrunedObject {
  key: string;
  size: number;
  lastModified?: Date;
}

export interface PruneResult {
  pruned: PrunedObject[];
  keptCount: number;
  prunedBytes: number;
  dryRun: boolean;
}

/** The subset of an S3 tier pruning needs: no version or restore/save-ref concerns apply. */
export interface PruneTier {
  storage: StorageContext;
  template: KeyTemplate;
}

const DEFAULT_CONCURRENCY = 8;
const LOG_CAP = 200;
const ERROR_SAMPLE_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ListedObject {
  key: string;
  size: number;
  lastModified?: Date;
}

/** Lists every object under `prefix` that `accept` allows, following continuation tokens. */
async function listArchiveObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  accept: (key: string) => boolean,
  pageSize = 1000
): Promise<ListedObject[]> {
  const objects: ListedObject[] = [];
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
      if (!object.Key || !accept(object.Key)) {
        continue;
      }
      objects.push({
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function logPruned(objects: readonly ListedObject[], now: Date, dryRun: boolean): void {
  const verb = dryRun ? 'Would prune' : 'Pruned';
  for (const object of objects.slice(0, LOG_CAP)) {
    const ageDays = object.lastModified
      ? Math.floor((now.getTime() - object.lastModified.getTime()) / DAY_MS)
      : 0;
    core.info(`${verb} ${object.key} (${formatSize(object.size)}, ${ageDays}d old)`);
  }
  const totalBytes = objects.reduce((total, object) => total + object.size, 0);
  core.info(`${verb} ${objects.length} cache object(s) totaling ${formatSize(totalBytes)}.`);
}

function refusal(problem: ScopeProblem, ref: string | undefined): string {
  switch (problem) {
    case 'no-archive-filename':
      return 'Refusing to prune: s3-key-pattern has no ${archive_filename}, so cache archives cannot be told apart from other objects.';
    case 'repository-shares-segment':
      return 'Refusing to prune: s3-key-pattern puts ${GITHUB_REPOSITORY} in a path segment with ${key}, ${version} or a preceding ${ref}, so other repositories\' caches could match. Separate ${GITHUB_REPOSITORY} from them with "/".';
    case 'ref-shares-segment':
      return `Refusing to prune ref "${ref}": s3-key-pattern puts \${ref} in a path segment with \${key}, \${version} or another \${ref}, so other refs' caches could match. Separate \${ref} from them with "/", or leave "ref" empty to prune every ref.`;
    case 'no-ref':
      return `Refusing to prune ref "${ref}": s3-key-pattern has no \${ref}, so every ref shares the same object keys. Leave "ref" empty to prune them all.`;
  }
}

/**
 * Deletes cache archives older than `options.olderThanDays` in the repository/ref scope
 * `tier.template` resolves, or lists them without deleting when `options.dryRun` is set. Objects
 * are listed under the template's fixed scope prefix, and only those whose whole key matches the
 * template (any key and version, either archive filename) are candidates, so nothing outside the
 * scope and nothing that is not a cache archive is ever touched. Refuses a scope the template
 * cannot tell apart from other repositories or refs.
 */
export async function pruneCaches(tier: PruneTier, options: PruneOptions): Promise<PruneResult> {
  const problem = tier.template.scopeProblem(options.ref);
  if (problem) {
    throw new Error(refusal(problem, options.ref));
  }
  const prefix = tier.template.scopePrefix(options.ref);
  if (prefix === '') {
    throw new Error(
      'Refusing to prune: s3-key-pattern leaves no fixed prefix to list under, which would scan the whole bucket. Set "prefix", keep "scoped-to-repository" enabled, or set "ref" when the pattern starts with ${ref}.'
    );
  }

  const { client, bucket } = tier.storage;
  const matcher = tier.template.scopeMatcher(options.ref);
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.olderThanDays * DAY_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const candidates = await listArchiveObjects(client, bucket, prefix, (key) => matcher.test(key));
  const stale = candidates.filter(
    (object) => object.lastModified !== undefined && object.lastModified.getTime() < cutoff
  );
  const keptCount = candidates.length - stale.length;

  const deletedKeys = new Set<string>();
  const failures: Array<{ key: string; error: unknown }> = [];
  if (!options.dryRun) {
    await mapWithConcurrency(stale, concurrency, async (object) => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }));
        deletedKeys.add(object.key);
      } catch (err) {
        failures.push({ key: object.key, error: err });
      }
    });
  }

  const prunedObjects = options.dryRun
    ? stale
    : stale.filter((object) => deletedKeys.has(object.key));
  logPruned(prunedObjects, now, options.dryRun);

  if (failures.length > 0) {
    const sample = failures.slice(0, ERROR_SAMPLE_CAP).map((failure) => failure.key);
    const more =
      failures.length > ERROR_SAMPLE_CAP ? `, and ${failures.length - ERROR_SAMPLE_CAP} more` : '';
    throw new AggregateError(
      failures.map((failure) => toError(failure.error)),
      `Failed to delete ${failures.length} cache object(s): ${sample.join(', ')}${more}`
    );
  }

  return {
    pruned: prunedObjects.map(({ key, size, lastModified }) => ({ key, size, lastModified })),
    keptCount,
    prunedBytes: prunedObjects.reduce((total, object) => total + object.size, 0),
    dryRun: options.dryRun,
  };
}
