import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Defaults } from '../../src/constants';
import { compileKeyTemplate } from '../../src/core/keyTemplate';
import { pruneCaches } from '../../src/core/prune';
import { saveImpl } from '../../src/core/saveImpl';
import type { StorageContext } from '../../src/storage/client';
import { MemoryState } from '../support/memoryState';
import {
  createTestS3Client,
  deleteTestPrefix,
  getTestS3Config,
  prepareTestBucket,
} from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

/**
 * What each server does with ListMultipartUploads, measured on 2026-10-21 (local runs of RustFS
 * 1.0.0, SeaweedFS 4.46 and MinIO 0.20260330, and the Garage job of CI run 39524953997; the AWS
 * Emulator 1.0.322 measured on 2026-11-12):
 * - `aborts`: the listing under a prefix returns the uploads with an Initiated time, so prune
 *   aborts the stale ones. RustFS, Garage and the AWS Emulator.
 * - `noInitiated`: the listing returns the uploads but without an Initiated time, so prune skips
 *   them and warns. SeaweedFS.
 * - `noPrefixListing`: the listing returns nothing for a prefix that is not a full object key, so
 *   prune finds no upload. MinIO.
 * A provider that nobody measured is expected to abort.
 */
type UploadListing = 'aborts' | 'noInitiated' | 'noPrefixListing';
const UPLOAD_LISTING: Record<string, UploadListing> = {
  'aws-emulator': 'aborts',
  rustfs: 'aborts',
  garage: 'aborts',
  seaweedfs: 'noInitiated',
  minio: 'noPrefixListing',
};

const s3 = getTestS3Config();
const uploadListing: UploadListing = UPLOAD_LISTING[s3.provider] ?? 'aborts';
const runId = `${Date.now()}-${process.pid}`;
let available = false;
let client: S3Client;
let workspace: string;
let scratch: string;
let outputFile: string;
let restoreEnv: () => void;

const itS3 = (name: string, fn: () => Promise<void>, timeout = 60_000): void => {
  it(
    name,
    async () => {
      if (!available) {
        console.log(
          `Skipping "${name}": no S3 server at ${s3.endpoint} (set REQUIRE_S3=1 to fail instead).`
        );
        return;
      }
      await fn();
    },
    timeout
  );
};

function setInputs(values: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  const all: Record<string, string> = {
    bucket: s3.bucket,
    endpoint: s3.endpoint,
    region: s3.region,
    provider: s3.provider,
    'access-key': s3.accessKeyId,
    'secret-key': s3.secretAccessKey,
    'force-path-style': 'true',
    retry: 'false',
    ...values,
  };
  for (const [name, value] of Object.entries(all)) {
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value;
  }
}

function takeOutputs(): Record<string, string> {
  const text = fs.readFileSync(outputFile, 'utf8');
  fs.writeFileSync(outputFile, '');
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(
    /^(.+?)<<(ghadelimiter_[0-9a-f-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm
  )) {
    outputs[match[1]] = match[3];
  }
  return outputs;
}

/** Saves one cache through the real S3 tier and returns the object key it was stored under. */
async function saveArchive(
  repository: string,
  ref: string,
  key: string,
  content: string
): Promise<string> {
  writeFiles(workspace, { 'data/f.txt': content });
  process.env.GITHUB_REPOSITORY = repository;
  process.env.GITHUB_REF = ref;
  setInputs({ key, path: 'data' });
  await saveImpl(new MemoryState());
  expect(process.exitCode ?? 0).toBe(0);
  const objectKey = takeOutputs()['cache-s3-key'];
  expect(objectKey).toBeTruthy();
  fs.rmSync(path.join(workspace, 'data'), { recursive: true, force: true });
  return objectKey;
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
    return true;
  } catch (err: unknown) {
    const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

beforeAll(async () => {
  available = await prepareTestBucket(s3);
  client = createTestS3Client(s3);
});

afterAll(() => {
  client.destroy();
});

beforeEach(() => {
  workspace = makeTempDir('prune-ws');
  scratch = makeTempDir('prune-run');
  outputFile = path.join(scratch, 'output.txt');
  fs.writeFileSync(outputFile, '');
  const eventPath = path.join(scratch, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  restoreEnv = setEnv({
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `cloud-cache-it/prune-${runId}`,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_BASE_REF: undefined,
  });
  process.exitCode = undefined;
});

afterAll(async () => {
  if (available) {
    for (const name of [
      'prune',
      'prune-other',
      'prune-count',
      'prune-count-other',
      'prune-uploads',
      'prune-uploads-other',
    ]) {
      await deleteTestPrefix(s3, `cloud-cache-it/${name}-${runId}/`);
    }
  }
});

afterEach(() => {
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  restoreEnv();
  removeDir(workspace);
  removeDir(scratch);
});

describe('pruneCaches integration', () => {
  itS3(
    'deletes only stale archive objects under the repository/ref prefix, leaving a dry run and other repositories untouched',
    async () => {
      const repository = `cloud-cache-it/prune-${runId}`;
      const otherRepository = `cloud-cache-it/prune-other-${runId}`;

      const featureKey = await saveArchive(repository, 'refs/heads/feature', 'k1', 'feature-data');
      const mainKey = await saveArchive(repository, 'refs/heads/main', 'k2', 'main-data');
      const otherRepoKey = await saveArchive(
        otherRepository,
        'refs/heads/main',
        'k1',
        'other-data'
      );

      // A non-archive object under the same repository/ref prefix must never be touched.
      const strayKey = `${repository}/refs%2Fheads%2Ffeature/stray/notes.txt`;
      await client.send(
        new PutObjectCommand({ Bucket: s3.bucket, Key: strayKey, Body: 'not a cache archive' })
      );

      const template = compileKeyTemplate({
        pattern: Defaults.DefaultS3KeyPattern,
        repository,
        prefix: '',
        scopedToRepository: true,
        scopedToRef: true,
        version: '',
        archiveFilename: 'cache.tar.zst',
        env: {},
      });
      const storage: StorageContext = {
        client,
        bucket: s3.bucket,
        providerConfig: {
          provider: s3.provider as 'seaweedfs',
          region: s3.region,
          forcePathStyle: true,
        },
      };

      // The objects were just created; a `now` far in the future makes them look stale without
      // needing to age real objects on the server.
      const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);

      const dryRun = await pruneCaches(
        { storage, template },
        { olderThanDays: 1, dryRun: true, now: farFuture }
      );
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.pruned.map((p) => p.key).sort()).toEqual([featureKey, mainKey].sort());
      expect(dryRun.keptCount).toBe(0);

      // A dry run must not have deleted anything.
      expect(await objectExists(featureKey)).toBe(true);
      expect(await objectExists(mainKey)).toBe(true);
      expect(await objectExists(strayKey)).toBe(true);
      expect(await objectExists(otherRepoKey)).toBe(true);

      const real = await pruneCaches(
        { storage, template },
        { olderThanDays: 1, dryRun: false, now: farFuture }
      );
      expect(real.dryRun).toBe(false);
      expect(real.pruned.map((p) => p.key).sort()).toEqual([featureKey, mainKey].sort());

      // The real run deleted both archives under this repository...
      expect(await objectExists(featureKey)).toBe(false);
      expect(await objectExists(mainKey)).toBe(false);
      // ...but left the non-archive object and the other repository's cache alone.
      expect(await objectExists(strayKey)).toBe(true);
      expect(await objectExists(otherRepoKey)).toBe(true);
    }
  );
  itS3(
    'keeps the newest archives of each ref and prunes to a size budget, leaving other repositories alone',
    async () => {
      const repository = `cloud-cache-it/prune-count-${runId}`;
      const otherRepository = `cloud-cache-it/prune-count-other-${runId}`;
      // S3 stores LastModified in whole seconds, so each save waits to get a distinct time.
      const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1100));

      const oldest = await saveArchive(repository, 'refs/heads/main', 'k1', 'main-data-1');
      await tick();
      const middle = await saveArchive(repository, 'refs/heads/main', 'k2', 'main-data-2');
      await tick();
      const newest = await saveArchive(repository, 'refs/heads/main', 'k3', 'main-data-3');
      const featureKey = await saveArchive(repository, 'refs/heads/feature', 'k1', 'feature-data');
      const otherRepoKey = await saveArchive(otherRepository, 'refs/heads/main', 'k1', 'other');

      const template = compileKeyTemplate({
        pattern: Defaults.DefaultS3KeyPattern,
        repository,
        prefix: '',
        scopedToRepository: true,
        scopedToRef: true,
        version: '',
        archiveFilename: 'cache.tar.zst',
        env: {},
      });
      const storage: StorageContext = {
        client,
        bucket: s3.bucket,
        providerConfig: {
          provider: s3.provider as 'seaweedfs',
          region: s3.region,
          forcePathStyle: true,
        },
      };
      const tier = { storage, template };

      // keep-latest counts per ref: the lone feature archive stays, main loses its oldest two.
      const dryRun = await pruneCaches(tier, { keepLatest: 1, dryRun: true });
      expect(dryRun.pruned.map((p) => p.key).sort()).toEqual([oldest, middle].sort());
      expect(dryRun.keptCount).toBe(2);
      expect(await objectExists(oldest)).toBe(true);

      const real = await pruneCaches(tier, { keepLatest: 2, dryRun: false });
      expect(real.pruned.map((p) => p.key)).toEqual([oldest]);
      expect(await objectExists(oldest)).toBe(false);
      expect(await objectExists(middle)).toBe(true);

      // A budget alone deletes the oldest archive of the whole scope, whatever its ref. The budget
      // is one byte under the total, so one deletion is enough.
      const sizeOf = async (key: string): Promise<number> =>
        (await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }))).ContentLength ??
        0;
      const total = (await sizeOf(middle)) + (await sizeOf(newest)) + (await sizeOf(featureKey));
      const budget = await pruneCaches(tier, { maxTotalSize: total - 1, dryRun: false });
      expect(budget.pruned.map((p) => p.key)).toEqual([middle]);
      expect(await objectExists(middle)).toBe(false);

      // With keep-latest, the budget still decides, but the newest archive of each ref stays,
      // even when the budget is 0.
      const zero = await pruneCaches(tier, { keepLatest: 1, maxTotalSize: 0, dryRun: false });
      expect(zero.pruned).toEqual([]);
      expect(await objectExists(newest)).toBe(true);
      expect(await objectExists(featureKey)).toBe(true);
      expect(await objectExists(otherRepoKey)).toBe(true);
    },
    120_000
  );
  itS3(
    'aborts only stale incomplete uploads inside the prune scope, and lists them in a dry run',
    async () => {
      const repository = `cloud-cache-it/prune-uploads-${runId}`;
      const otherRepository = `cloud-cache-it/prune-uploads-other-${runId}`;
      const scopeKey = `${repository}/refs%2Fheads%2Fmain/stale/v1/cache.tar.zst`;
      const strayKey = `${repository}/refs%2Fheads%2Fmain/stale/v1/notes.txt`;
      const otherKey = `${otherRepository}/refs%2Fheads%2Fmain/stale/v1/cache.tar.zst`;

      const start = async (key: string): Promise<string> => {
        const started = await client.send(
          new CreateMultipartUploadCommand({ Bucket: s3.bucket, Key: key })
        );
        expect(started.UploadId).toBeTruthy();
        return started.UploadId as string;
      };
      // The test lists the whole bucket and filters the keys itself, because MinIO lists nothing
      // for a prefix that is not a full object key.
      const open = async (repo: string): Promise<Array<{ key?: string; id?: string }>> => {
        const found: Array<{ key?: string; id?: string }> = [];
        let keyMarker: string | undefined;
        let uploadIdMarker: string | undefined;
        do {
          const listed = await client.send(
            new ListMultipartUploadsCommand({
              Bucket: s3.bucket,
              KeyMarker: keyMarker,
              UploadIdMarker: uploadIdMarker,
            })
          );
          for (const u of listed.Uploads ?? []) {
            if (u.Key?.startsWith(`${repo}/`)) {
              found.push({ key: u.Key, id: u.UploadId });
            }
          }
          keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
          uploadIdMarker = listed.IsTruncated ? listed.NextUploadIdMarker : undefined;
        } while (keyMarker !== undefined || uploadIdMarker !== undefined);
        return found;
      };

      const scopeId = await start(scopeKey);
      const strayId = await start(strayKey);
      const otherId = await start(otherKey);

      const template = compileKeyTemplate({
        pattern: Defaults.DefaultS3KeyPattern,
        repository,
        prefix: '',
        scopedToRepository: true,
        scopedToRef: true,
        version: '',
        archiveFilename: 'cache.tar.zst',
        env: {},
      });
      const storage: StorageContext = {
        client,
        bucket: s3.bucket,
        providerConfig: {
          provider: s3.provider as 'seaweedfs',
          region: s3.region,
          forcePathStyle: true,
        },
      };
      const tier = { storage, template };
      // The uploads just started; a `now` two days ahead makes them look stale.
      const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const sameUploads = (
        actual: Array<{ key?: string; id?: string }>,
        expected: Array<{ key?: string; id?: string }>
      ): void => {
        const order = (list: Array<{ key?: string; id?: string }>) =>
          [...list].sort((a, b) => `${a.key}`.localeCompare(`${b.key}`));
        expect(order(actual)).toEqual(order(expected));
      };
      const stdout = jest.spyOn(process.stdout, 'write');
      const warned = (text: string): boolean =>
        stdout.mock.calls.some(
          ([chunk]) => String(chunk).startsWith('::warning::') && String(chunk).includes(text)
        );

      try {
        sameUploads(await open(repository), [
          { key: scopeKey, id: scopeId },
          { key: strayKey, id: strayId },
        ]);
        if (uploadListing !== 'aborts') {
          // The server cannot give prune the age of the uploads, so prune aborts nothing, also when
          // the uploads look stale. On SeaweedFS, prune says so in a warning.
          const blind = await pruneCaches(tier, {
            abortUploadsOlderThanHours: 24,
            dryRun: false,
            now: later,
          });
          expect(blind.abortedUploads).toBe(0);
          expect(warned('Skipped 1 incomplete upload(s)')).toBe(uploadListing === 'noInitiated');
          expect(await open(repository)).toHaveLength(2);
          expect(await open(otherRepository)).toEqual([{ key: otherKey, id: otherId }]);
          return;
        }

        // Right now the uploads are younger than the limit, so nothing is aborted.
        const fresh = await pruneCaches(tier, { abortUploadsOlderThanHours: 24, dryRun: false });
        expect(fresh.abortedUploads).toBe(0);
        expect(await open(repository)).toHaveLength(2);

        const dryRun = await pruneCaches(tier, {
          abortUploadsOlderThanHours: 24,
          dryRun: true,
          now: later,
        });
        expect(dryRun.abortedUploads).toBe(1);
        expect(await open(repository)).toHaveLength(2);

        const real = await pruneCaches(tier, {
          abortUploadsOlderThanHours: 24,
          dryRun: false,
          now: later,
        });
        expect(real.abortedUploads).toBe(1);
        expect(real.pruned).toEqual([]);
        // The archive upload is gone. The non-archive upload and the other repository stay.
        expect(await open(repository)).toEqual([{ key: strayKey, id: strayId }]);
        expect(await open(otherRepository)).toEqual([{ key: otherKey, id: otherId }]);
      } finally {
        stdout.mockRestore();
        for (const [key, id] of [
          [scopeKey, scopeId],
          [strayKey, strayId],
          [otherKey, otherId],
        ]) {
          await client
            .send(new AbortMultipartUploadCommand({ Bucket: s3.bucket, Key: key, UploadId: id }))
            .catch(() => undefined);
        }
      }
    }
  );
});
