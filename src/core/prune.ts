import { log } from '../ci/log';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { formatSize } from '../utils/inputUtils';
import { mapWithConcurrency } from '../utils/concurrency';
import type { KeyTemplate, ScopeProblem } from './keyTemplate';
import {
  NO_RULE_MESSAGE,
  hasPruneRule,
  selectForPrune,
  type PruneRules,
  type Selection,
} from './pruneSelect';
import { toError } from './outcomes';
import type { StorageContext } from '../storage/client';

export interface PruneOptions extends PruneRules {
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
  /** Incomplete uploads aborted (or that would be aborted in a dry run). */
  abortedUploads: number;
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
const HOUR_MS = 60 * 60 * 1000;

interface ListedObject {
  key: string;
  size: number;
  lastModified?: Date;
  /** The ref segment of the key; '' when the key template has no ref segment. */
  group: string;
}

/**
 * Lists every object under `prefix` that `groupOf` gives a group, following continuation tokens.
 * `groupOf` returns undefined for an object that is not a candidate.
 */
async function listArchiveObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  groupOf: (key: string) => string | undefined,
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
      const group = object.Key ? groupOf(object.Key) : undefined;
      if (!object.Key || group === undefined) {
        continue;
      }
      objects.push({
        group,
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

interface StaleUpload {
  key: string;
  uploadId: string;
  initiated: Date;
}

/**
 * Lists the incomplete multipart uploads under `prefix` that `isCandidate` accepts and that were
 * initiated before `cutoff`, following the key and upload-id markers. An upload with no
 * `Initiated` time is skipped, because its age is unknown, and `withoutAge` counts these uploads.
 */
async function listStaleUploads(
  client: S3Client,
  bucket: string,
  prefix: string,
  isCandidate: (key: string) => boolean,
  cutoff: Date
): Promise<{ stale: StaleUpload[]; withoutAge: number }> {
  const uploads: StaleUpload[] = [];
  let withoutAge = 0;
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      })
    );
    for (const upload of page.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId || !isCandidate(upload.Key)) {
        continue;
      }
      if (!upload.Initiated) {
        withoutAge += 1;
      } else if (upload.Initiated < cutoff) {
        uploads.push({ key: upload.Key, uploadId: upload.UploadId, initiated: upload.Initiated });
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (keyMarker !== undefined || uploadIdMarker !== undefined);
  return { stale: uploads, withoutAge };
}

/**
 * Aborts the stale incomplete uploads, or only lists them when `dryRun` is set, and returns how
 * many it aborted (or would abort). This step never fails the prune: a provider that cannot list
 * uploads, such as one that answers NotImplemented, gives a warning and a count of 0. An upload
 * that no longer exists is ignored, and any other abort error gives a warning for that upload.
 */
async function abortStaleUploads(
  client: S3Client,
  bucket: string,
  prefix: string,
  isCandidate: (key: string) => boolean,
  options: { olderThanHours: number; now: Date; dryRun: boolean; concurrency: number }
): Promise<number> {
  const { olderThanHours, now, dryRun } = options;
  const cutoff = new Date(now.getTime() - olderThanHours * HOUR_MS);
  let stale: StaleUpload[];
  try {
    const listed = await listStaleUploads(client, bucket, prefix, isCandidate, cutoff);
    stale = listed.stale;
    if (listed.withoutAge > 0) {
      // SeaweedFS lists uploads without an Initiated time, so this rule cannot work there.
      log.warning(
        `Skipped ${listed.withoutAge} incomplete upload(s): the server lists them without an initiation time, so their age is unknown and they are not aborted. SeaweedFS is one such server.`
      );
    }
  } catch (err) {
    const error = toError(err);
    log.warning(
      `Could not list incomplete multipart uploads, so none are aborted: ${error.name}: ${error.message}`
    );
    return 0;
  }

  const verb = dryRun ? 'Would abort' : 'Aborted';
  let count = 0;
  const abortOne = async (upload: StaleUpload): Promise<void> => {
    const age = `${Math.floor((now.getTime() - upload.initiated.getTime()) / HOUR_MS)}h old`;
    if (!dryRun) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
          })
        );
      } catch (err) {
        const error = toError(err);
        // The upload finished or was aborted between the listing and this call.
        if (error.name !== 'NoSuchUpload') {
          log.warning(
            `Could not abort the incomplete upload of ${upload.key} (upload ${upload.uploadId}): ${error.name}: ${error.message}`
          );
        }
        return;
      }
    }
    count += 1;
    if (count <= LOG_CAP) {
      log.info(`${verb} ${upload.key} (upload ${upload.uploadId}, ${age})`);
    }
  };
  await mapWithConcurrency(stale, options.concurrency, abortOne);
  log.info(`${verb} ${count} incomplete upload(s).`);
  return count;
}

function logPruned(
  selections: ReadonlyArray<Selection<ListedObject>>,
  now: Date,
  dryRun: boolean
): void {
  const verb = dryRun ? 'Would prune' : 'Pruned';
  for (const { object, reason } of selections.slice(0, LOG_CAP)) {
    const ageDays = object.lastModified
      ? Math.floor((now.getTime() - object.lastModified.getTime()) / DAY_MS)
      : 0;
    log.info(`${verb} ${object.key} (${formatSize(object.size)}, ${ageDays}d old, ${reason})`);
  }
  const totalBytes = selections.reduce((total, { object }) => total + object.size, 0);
  const counts = new Map<string, number>();
  for (const { reason } of selections) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const reasons = [...counts].map(([reason, count]) => `${count} by ${reason}`).join(', ');
  log.info(
    `${verb} ${selections.length} cache object(s) totaling ${formatSize(totalBytes)}${reasons ? ` (${reasons})` : ''}.`
  );
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
 * Deletes cache archives chosen by the `options` rules (age, keep-latest per ref, total size) in
 * the repository/ref scope `tier.template` resolves, or lists them without deleting when
 * `options.dryRun` is set. The rules are in `./pruneSelect`. Objects
 * are listed under the template's fixed scope prefix, and only those whose whole key matches the
 * template (any key and version, either archive filename) are candidates, so nothing outside the
 * scope and nothing that is not a cache archive is ever touched. Refuses a scope the template
 * cannot tell apart from other repositories or refs.
 */
export async function pruneCaches(tier: PruneTier, options: PruneOptions): Promise<PruneResult> {
  if (!hasPruneRule(options)) {
    throw new Error(NO_RULE_MESSAGE);
  }
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
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const abortedUploads =
    options.abortUploadsOlderThanHours === undefined
      ? 0
      : await abortStaleUploads(client, bucket, prefix, (key) => matcher.test(key), {
          olderThanHours: options.abortUploadsOlderThanHours,
          now,
          dryRun: options.dryRun,
          concurrency,
        });

  const candidates = await listArchiveObjects(client, bucket, prefix, (key) => {
    const match = matcher.exec(key);
    return match ? (match.groups?.ref ?? options.ref ?? '') : undefined;
  });
  const { selected, overBudgetBytes } = selectForPrune(candidates, options, now);
  if (overBudgetBytes > 0) {
    log.warning(
      `The remaining cache archives are still ${formatSize(overBudgetBytes)} over "max-total-size": the "keep-latest" archives and archives with no modification time are never pruned.`
    );
  }
  const keptCount = candidates.length - selected.length;
  const stale = selected.map(({ object }) => object);

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

  const prunedSelections = options.dryRun
    ? selected
    : selected.filter(({ object }) => deletedKeys.has(object.key));
  const prunedObjects = prunedSelections.map(({ object }) => object);
  logPruned(prunedSelections, now, options.dryRun);

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
    abortedUploads,
    dryRun: options.dryRun,
  };
}
