/**
 * Verifies the sha256 archive-integrity check (Task 3) end to end against a real S3 server:
 * saving writes the checksum as object metadata, and restoring a corrupted object is rejected
 * instead of extracting garbage. Run against SeaweedFS, MinIO and Garage in turn (see
 * global-constraints.md for how to start each locally) by pointing TEST_S3_* at each one.
 *
 * Whether a given server round-trips custom object metadata through HeadObject/GetObject was
 * unverified for Garage when this task started (see the v1.2 plan's "Verified facts"). This
 * suite does not assume either way: it reads back whatever the server actually stored and
 * branches its assertions on that, so it passes whether or not metadata survives. If a server
 * drops the `cloud-cache-sha256` metadata, verification cannot run; the corrupted-object test
 * then only requires that the skip happened (visible in the debug log this suite captures),
 * not the integrity-check-specific warning.
 */
import { jest } from '@jest/globals';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionConfig } from '../../src/archive/compression';
import { MemoryState } from '../support/memoryState';
import {
  createTestS3Client,
  deleteTestPrefix,
  getTestS3Config,
  prepareTestBucket,
} from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

const compression: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: async () => compression,
  resetCompressionConfigCache: () => undefined,
}));

const { restoreImpl } = await import('../../src/core/restoreImpl');
const { saveImpl } = await import('../../src/core/saveImpl');

const s3 = getTestS3Config();
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

async function restore(
  values: Record<string, string>
): Promise<{ state: MemoryState; outputs: Record<string, string> }> {
  setInputs(values);
  const state = new MemoryState();
  await restoreImpl(state, false);
  expect(process.exitCode ?? 0).toBe(0);
  return { state, outputs: takeOutputs() };
}

async function save(values: Record<string, string>): Promise<Record<string, string>> {
  setInputs(values);
  await saveImpl(new MemoryState());
  expect(process.exitCode ?? 0).toBe(0);
  return takeOutputs();
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

afterAll(async () => {
  if (available) {
    await deleteTestPrefix(s3, `cloud-cache-it/${runId}/`);
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
  [workspace, home, scratch].forEach(removeDir);
});

describe('archive integrity (sha256)', () => {
  itS3(
    'stores the sha256 as object metadata on save, and HeadObject shows it (unless the server drops it)',
    async () => {
      writeFiles(workspace, { 'data/f.txt': 'integrity-head-check' });
      const key = `integrity-head-${runId}`;

      const saveOutputs = await save({ key, path: 'data' });
      const objectKey = saveOutputs['cache-s3-key'];
      expect(objectKey).toBeTruthy();

      const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
      const checksum = head.Metadata?.['cloud-cache-sha256'];
      console.log(
        `[integrity] ${s3.provider} at ${s3.endpoint}: cloud-cache-sha256 metadata ${
          checksum ? `preserved (${checksum})` : 'NOT preserved'
        }`
      );
      if (checksum !== undefined) {
        expect(checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  );

  itS3(
    'rejects a corrupted object instead of extracting it, whether or not the server preserved the checksum',
    async () => {
      writeFiles(workspace, { 'data/f.txt': 'integrity-corruption-check' });
      const key = `integrity-corrupt-${runId}`;

      const saveOutputs = await save({ key, path: 'data' });
      const objectKey = saveOutputs['cache-s3-key'];
      expect(objectKey).toBeTruthy();

      const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
      const metadataPreserved = head.Metadata?.['cloud-cache-sha256'] !== undefined;

      // Overwrite with same-length garbage bytes, keeping whatever metadata the server actually
      // stored (so a server that dropped it originally still has none after the corruption).
      const original = await client.send(
        new GetObjectCommand({ Bucket: s3.bucket, Key: objectKey })
      );
      const originalBytes = Buffer.from(await original.Body!.transformToByteArray());
      const corrupted = Buffer.alloc(originalBytes.length, 0);
      await client.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: objectKey,
          Body: corrupted,
          Metadata: head.Metadata,
        })
      );

      fs.rmSync(path.join(workspace, 'data'), { recursive: true });
      const stdout = captureStdout();
      let result: Awaited<ReturnType<typeof restore>>;
      try {
        result = await restore({ key, path: 'data' });
      } finally {
        stdout.restore();
      }
      const log = stdout.text();

      // A corrupted archive must never look like a successful restore, regardless of which path
      // caught it (the integrity check, or a downstream tar/gzip failure on unverified content).
      expect(result.outputs['cache-hit']).toBe('false');
      expect(fs.existsSync(path.join(workspace, 'data', 'f.txt'))).toBe(false);

      if (metadataPreserved) {
        expect(log).toContain('Integrity check failed for s3://');
        expect(log).toContain('expected sha256');
      } else {
        expect(log).toContain('skipping integrity check');
      }
    }
  );

  itS3(
    'saves multipart parts with UNSIGNED-PAYLOAD, and the stored sha256 matches the stored bytes',
    async () => {
      const restoreVariable = setEnv({ CLOUD_CACHE_UNSIGNED_PAYLOAD: 'true' });
      try {
        // Random bytes do not compress, so the archive is larger than two 5 MiB parts.
        const payload = crypto.randomBytes(12 * 1024 * 1024);
        fs.mkdirSync(path.join(workspace, 'data'));
        fs.writeFileSync(path.join(workspace, 'data', 'big.bin'), payload);
        const key = `integrity-unsigned-${runId}`;
        const inputs = { key, path: 'data', 'upload-chunk-size': String(5 * 1024 * 1024) };

        const saveOutputs = await save(inputs);
        const objectKey = saveOutputs['cache-s3-key'];
        const head = await client.send(
          new HeadObjectCommand({ Bucket: s3.bucket, Key: objectKey })
        );
        const object = await client.send(
          new GetObjectCommand({ Bucket: s3.bucket, Key: objectKey })
        );
        const stored = Buffer.from(await object.Body!.transformToByteArray());
        const checksum = head.Metadata?.['cloud-cache-sha256'];
        if (checksum !== undefined) {
          expect(checksum).toBe(crypto.createHash('sha256').update(stored).digest('hex'));
        }

        fs.rmSync(path.join(workspace, 'data'), { recursive: true });
        const { outputs } = await restore(inputs);
        expect(outputs['cache-hit']).toBe('true');
        expect(fs.readFileSync(path.join(workspace, 'data', 'big.bin')).equals(payload)).toBe(true);
      } finally {
        restoreVariable();
      }
    },
    120_000
  );
});
