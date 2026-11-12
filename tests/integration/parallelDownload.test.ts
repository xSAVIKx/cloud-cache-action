/**
 * Verifies the ranged, parallel download end to end against a real S3 server: an archive larger
 * than `download-chunk-size` is fetched in concurrent `Range` parts, in file mode and in
 * streaming mode, and the restored files match what was saved. Run against SeaweedFS, MinIO and
 * Garage in turn by pointing TEST_S3_* at each one.
 */
import { jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionConfig } from '../../src/archive/compression';
import { MemoryState } from '../support/memoryState';
import { deleteTestPrefix, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, setEnv } from '../support/tempTree';

const compression: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: async () => compression,
  resetCompressionConfigCache: () => undefined,
}));

const { restoreImpl } = await import('../../src/core/restoreImpl');
const { saveImpl } = await import('../../src/core/saveImpl');

const s3 = getTestS3Config();
const runId = `${Date.now()}-${process.pid}`;
const MiB = 1024 * 1024;
let available = false;
let workspace: string;
let home: string;
let scratch: string;
let outputFile: string;
let restoreEnv: () => void;

const itS3 = (name: string, fn: () => Promise<void>, timeout = 120_000): void => {
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

/** Captures everything @actions/core writes, since its exports cannot be spied on under ESM. */
function captureStdout(): { text(): string; restore(): void } {
  let buffer = '';
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  });
  return { text: () => buffer, restore: () => spy.mockRestore() };
}

async function restore(
  values: Record<string, string>
): Promise<{ outputs: Record<string, string>; log: string }> {
  setInputs(values);
  const stdout = captureStdout();
  try {
    await restoreImpl(new MemoryState(), false);
  } finally {
    stdout.restore();
  }
  expect(process.exitCode ?? 0).toBe(0);
  return { outputs: takeOutputs(), log: stdout.text() };
}

async function save(values: Record<string, string>): Promise<Record<string, string>> {
  setInputs(values);
  await saveImpl(new MemoryState());
  expect(process.exitCode ?? 0).toBe(0);
  return takeOutputs();
}

function metricsLine(log: string): Record<string, unknown> {
  const match = /cloud-cache-metrics (\{.*\})/.exec(log);
  if (!match) {
    throw new Error(`No metrics line in:\n${log}`);
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** Random bytes do not compress, so the archive is about as large as the files. */
function writeRandomFiles(root: string, files: Record<string, number>): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const [relative, size] of Object.entries(files)) {
    const bytes = crypto.randomBytes(size);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    digests[relative] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return digests;
}

function digestFiles(root: string, relatives: string[]): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const relative of relatives) {
    digests[relative] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, relative)))
      .digest('hex');
  }
  return digests;
}

beforeAll(async () => {
  available = await prepareTestBucket(s3);
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
    RUNNER_DEBUG: '1',
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

describe('parallel download', () => {
  const files = { 'data/a.bin': 2 * MiB + 12345, 'data/b.bin': MiB + 7, 'data/c/d.txt': 64 };
  const names = Object.keys(files);

  for (const streaming of ['false', 'true']) {
    itS3(`restores an archive fetched in ranged parts with streaming: ${streaming}`, async () => {
      const expected = writeRandomFiles(workspace, files);
      const key = `parallel-${streaming}-${runId}`;
      await save({ key, path: 'data', streaming });
      fs.rmSync(path.join(workspace, 'data'), { recursive: true });

      const { outputs, log } = await restore({
        key,
        path: 'data',
        streaming,
        'download-chunk-size': String(MiB),
        'download-concurrency': '3',
      });

      expect(outputs['cache-hit']).toBe('true');
      expect(digestFiles(workspace, names)).toEqual(expected);
      const size = Number(outputs['cache-size']);
      const parts = Math.ceil(size / MiB);
      expect(parts).toBeGreaterThanOrEqual(4);
      expect(log).toContain(`in ${parts} parts of 1.00 MB, 3 at a time`);
      expect(log).not.toContain('does not support ranged GET');
      expect(metricsLine(log)).toMatchObject({
        outcome: 'hit',
        streaming: streaming === 'true',
        downloadParts: parts,
      });
    });
  }

  itS3('downloads in one request when download-concurrency is 1', async () => {
    const expected = writeRandomFiles(workspace, files);
    const key = `parallel-single-${runId}`;
    await save({ key, path: 'data' });
    fs.rmSync(path.join(workspace, 'data'), { recursive: true });

    const { outputs, log } = await restore({
      key,
      path: 'data',
      'download-chunk-size': String(MiB),
      'download-concurrency': '1',
    });

    expect(outputs['cache-hit']).toBe('true');
    expect(digestFiles(workspace, names)).toEqual(expected);
    expect(log).not.toContain('parts of');
    expect(metricsLine(log)).toMatchObject({ outcome: 'hit', downloadParts: 1 });
  });

  itS3('downloads in one request when the archive fits in one chunk', async () => {
    writeRandomFiles(workspace, { 'data/small.bin': 4096 });
    const key = `parallel-small-${runId}`;
    await save({ key, path: 'data' });
    fs.rmSync(path.join(workspace, 'data'), { recursive: true });

    const { outputs, log } = await restore({ key, path: 'data' });

    expect(outputs['cache-hit']).toBe('true');
    expect(fs.existsSync(path.join(workspace, 'data', 'small.bin'))).toBe(true);
    expect(log).not.toContain('parts of');
    expect(metricsLine(log)).toMatchObject({ outcome: 'hit', downloadParts: 1 });
  });
});
