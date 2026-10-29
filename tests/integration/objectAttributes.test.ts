/**
 * Verifies the v1.3 `metadata`/`tags` inputs (Task 2/3) end to end against a real S3 server:
 * a file-mode save stores the user metadata and the sha256 on the object, sets object tags (or
 * warns once that the provider cannot), and a restore reports the metadata as `cache-metadata`;
 * a streamed save ends up with the same metadata, which only the CopyObject-onto-itself that
 * follows the upload can put there.
 *
 * The per-provider expectations in PROVIDER_SUPPORT below are measurements, not guesses: each
 * row is what the named server actually did when this suite was run against it (see the v1.3
 * Task 6 report and the provider table in docs/guide/storage.md). A provider not listed here is treated as
 * unmeasured: the suite still requires a documented outcome (the feature works, or the
 * documented best-effort warning fired) but does not require a particular one.
 */
import { jest } from '@jest/globals';
import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionConfig } from '../../src/archive/compression';
import { MemoryState } from '../support/memoryState';
import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

const compression: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: async () => compression,
  resetCompressionConfigCache: () => undefined,
}));

const { restoreImpl } = await import('../../src/core/restoreImpl');
const { saveImpl } = await import('../../src/core/saveImpl');
const { putObjectTags } = await import('../../src/storage/operations');

/**
 * What a server did with the tags the save asked for:
 * - `stored`: GetObjectTagging returns them.
 * - `warned`: the upload was rejected for carrying tags, and the documented one-time
 *   "could not store object tags" warning fired instead.
 * - `unverifiable`: the upload with the `x-amz-tagging` header was accepted, but the server does
 *   not implement the tagging API, so whether it kept the tags cannot be read back. Garage does
 *   exactly this: PutObject with tags succeeds, GetObjectTagging answers 501 NotImplemented.
 * - `missing`: tags neither stored nor accounted for. Never an acceptable outcome.
 */
type TagOutcome = 'stored' | 'warned' | 'unverifiable' | 'missing';

/** What each server was observed to do. `undefined` for a provider nobody has measured yet. */
interface ProviderSupport {
  tags: TagOutcome;
  /** The post-upload metadata copy of a streamed save succeeded (false: it warned instead). */
  streamedMetadata: boolean;
}

const PROVIDER_SUPPORT: Record<string, ProviderSupport> = {
  seaweedfs: { tags: 'stored', streamedMetadata: true },
  minio: { tags: 'stored', streamedMetadata: true },
  garage: { tags: 'unverifiable', streamedMetadata: true },
};

/** True when the server answered that it does not implement the tagging API at all. */
function isTaggingApiMissing(err: unknown): boolean {
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return error?.name === 'NotImplemented' || error?.$metadata?.httpStatusCode === 501;
}

const s3 = getTestS3Config();
const support: ProviderSupport | undefined = PROVIDER_SUPPORT[s3.provider];
const runId = `${Date.now()}-${process.pid}`;
let available = false;
let client: S3Client;
let workspace: string;
let home: string;
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

/**
 * Captures everything @actions/core writes (info/warning/debug all go through
 * process.stdout.write), since the module's exports cannot be spied on directly under Jest ESM.
 */
function captureStdout(): { text(): string; restore(): void } {
  let buffer = '';
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  });
  return {
    text: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

/** Runs a save and returns its outputs together with everything it logged. */
async function save(
  values: Record<string, string>
): Promise<{ outputs: Record<string, string>; log: string }> {
  setInputs(values);
  const stdout = captureStdout();
  try {
    await saveImpl(new MemoryState());
  } finally {
    stdout.restore();
  }
  expect(process.exitCode ?? 0).toBe(0);
  return { outputs: takeOutputs(), log: stdout.text() };
}

async function restore(values: Record<string, string>): Promise<Record<string, string>> {
  setInputs(values);
  await restoreImpl(new MemoryState(), false);
  expect(process.exitCode ?? 0).toBe(0);
  return takeOutputs();
}

beforeAll(async () => {
  available = await prepareTestBucket(s3);
  client = createTestS3Client(s3);
});

afterAll(() => {
  client?.destroy();
});

beforeEach(() => {
  workspace = makeTempDir('ws');
  home = makeTempDir('home');
  scratch = makeTempDir('run');
  outputFile = path.join(scratch, 'output.txt');
  fs.writeFileSync(outputFile, '');
  const eventPath = path.join(scratch, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  restoreEnv = setEnv({
    GITHUB_WORKSPACE: workspace,
    HOME: home,
    USERPROFILE: home,
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `cloud-cache-it/${runId}`,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_BASE_REF: undefined,
  });
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key];
    }
  }
  restoreEnv();
  [workspace, home, scratch].forEach(removeDir);
});

describe('object metadata and tags', () => {
  itS3(
    'stores user metadata and tags on the saved object and reports metadata on restore',
    async () => {
      writeFiles(workspace, { 'data/f.txt': 'object-attributes-file-mode' });
      const key = `attributes-file-${runId}`;

      const saved = await save({
        key,
        path: 'data',
        metadata: 'team=platform\nbuild=42',
        tags: 'repo=acme/app\nkind=cache',
      });
      const objectKey = saved.outputs['cache-s3-key'];
      expect(objectKey).toBeTruthy();

      const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
      expect(head.Metadata).toMatchObject({ team: 'platform', build: '42' });
      expect(head.Metadata?.['cloud-cache-sha256']).toMatch(/^[0-9a-f]{64}$/);

      let outcome: TagOutcome = 'missing';
      let tagSet: { Key?: string; Value?: string }[] | undefined;
      if (saved.log.includes('could not store object tags')) {
        outcome = 'warned';
      } else {
        try {
          const tagging = await client.send(
            new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: objectKey })
          );
          tagSet = tagging.TagSet;
          if (tagSet?.some((tag) => tag.Key === 'repo' && tag.Value === 'acme/app')) {
            outcome = 'stored';
          }
        } catch (err) {
          if (!isTaggingApiMissing(err)) {
            throw err;
          }
          outcome = 'unverifiable';
        }
      }
      console.log(`[attributes] ${s3.provider} at ${s3.endpoint}: object tags ${outcome}`);

      if (support === undefined) {
        // Unmeasured provider: any documented outcome is acceptable, silently losing the tags
        // without any trace is not.
        expect(outcome).not.toBe('missing');
      } else {
        expect(outcome).toBe(support.tags);
      }
      if (support?.tags === 'stored') {
        expect(tagSet).toEqual(
          expect.arrayContaining([
            { Key: 'repo', Value: 'acme/app' },
            { Key: 'kind', Value: 'cache' },
          ])
        );
      }

      const outputs = await restore({ key, path: 'data' });
      expect(outputs['cache-hit']).toBe('true');
      expect(JSON.parse(outputs['cache-metadata'])).toEqual({ team: 'platform', build: '42' });
    }
  );

  itS3('attaches sha256 and metadata to a streamed save', async () => {
    writeFiles(workspace, { 'data/f.txt': 'object-attributes-streamed' });
    const key = `attributes-stream-${runId}`;

    const saved = await save({
      key,
      path: 'data',
      streaming: 'true',
      metadata: 'team=platform',
    });
    const objectKey = saved.outputs['cache-s3-key'];
    expect(objectKey).toBeTruthy();

    const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
    const warned = saved.log.includes('could not attach metadata');
    const attached =
      head.Metadata?.team === 'platform' &&
      /^[0-9a-f]{64}$/.test(head.Metadata?.['cloud-cache-sha256'] ?? '');
    console.log(
      `[attributes] ${s3.provider} at ${s3.endpoint}: streamed metadata copy ${
        attached ? 'succeeded' : warned ? 'failed (warned)' : 'did NOT run and did NOT warn'
      }`
    );

    if (support?.streamedMetadata === true) {
      expect(warned).toBe(false);
      expect(head.Metadata?.['cloud-cache-sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(head.Metadata?.team).toBe('platform');
    } else if (support?.streamedMetadata === false) {
      expect(warned).toBe(true);
    } else {
      expect(attached || warned).toBe(true);
    }
  });

  itS3(
    'tags a streamed save without user metadata, and keeps its writer id out of cache-metadata',
    async () => {
      writeFiles(workspace, { 'data/f.txt': 'object-attributes-stream-tag' });
      const key = `attributes-stream-tag-${runId}`;

      const saved = await save({ key, path: 'data', streaming: 'true', tags: 'repo=acme/app' });
      const objectKey = saved.outputs['cache-s3-key'];
      expect(objectKey).toBeTruthy();
      expect(saved.log).not.toContain('replaced s3://');

      const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
      let tagSet: { Key?: string; Value?: string }[] | undefined;
      try {
        const tagging = await client.send(
          new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: objectKey })
        );
        tagSet = tagging.TagSet;
      } catch (err) {
        if (!isTaggingApiMissing(err)) {
          throw err;
        }
      }
      const tagged = tagSet?.some((tag) => tag.Key === 'cloud-cache-sha256') === true;
      console.log(
        `[attributes] ${s3.provider} at ${s3.endpoint}: streamed checksum ${
          tagged ? 'tagged' : 'copied'
        }, writer metadata ${head.Metadata?.['cloud-cache-writer'] ?? 'absent'}`
      );
      if (tagged) {
        // The tag path: the upload wrote this save's id, and the HEAD after the tag confirmed it.
        expect(head.Metadata?.['cloud-cache-writer']).toMatch(/^[0-9a-f-]{36}$/);
        expect(tagSet).toEqual(
          expect.arrayContaining([
            { Key: 'repo', Value: 'acme/app' },
            { Key: 'cloud-cache-sha256', Value: expect.stringMatching(/^[0-9a-f]{64}$/) },
          ])
        );
      } else {
        // No tagging API (Garage): the copy replaced the metadata with the checksum.
        expect(head.Metadata?.['cloud-cache-sha256']).toMatch(/^[0-9a-f]{64}$/);
      }

      const outputs = await restore({ key, path: 'data' });
      expect(outputs['cache-hit']).toBe('true');
      expect(JSON.parse(outputs['cache-metadata'])).toEqual({});
    }
  );

  itS3('removes the checksum tag with an empty tag set', async () => {
    // The rewrite a streamed save sends when it cannot keep its checksum tag and has no user
    // tags. S3 has no partial tag update, so the whole set is replaced, here by an empty set.
    const objectKey = `attributes-empty-tags-${runId}`;
    await client.send(
      new PutObjectCommand({ Bucket: s3.bucket, Key: objectKey, Body: 'empty-tag-set' })
    );
    try {
      await putObjectTags(client, s3.bucket, objectKey, [
        { Key: 'cloud-cache-sha256', Value: 'a'.repeat(64) },
      ]);
    } catch (err) {
      if (!isTaggingApiMissing(err)) {
        throw err;
      }
      console.log(
        `[attributes] ${s3.provider} at ${s3.endpoint}: no tagging API, nothing to remove`
      );
      return;
    }
    await putObjectTags(client, s3.bucket, objectKey, []);
    const tagging = await client.send(
      new GetObjectTaggingCommand({ Bucket: s3.bucket, Key: objectKey })
    );
    expect(tagging.TagSet ?? []).toEqual([]);
  });
});
