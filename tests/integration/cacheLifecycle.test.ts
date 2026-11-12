import { jest } from '@jest/globals';
import * as io from '@actions/io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionConfig } from '../../src/archive/compression';
import {
  buildFixtureTree,
  clearFixtureRoots,
  verifyFixtureTree,
  type FixtureRoots,
} from '../support/fixtureTree';
import { MemoryState } from '../support/memoryState';
import { deleteTestPrefix, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

let compression: CompressionConfig = { method: 'gzip', archiveFilename: 'cache.tar.gz' };

jest.unstable_mockModule('../../src/archive/compression', () => ({
  getCompressionConfig: async () => compression,
  resetCompressionConfigCache: () => undefined,
}));

const { restoreImpl } = await import('../../src/core/restoreImpl');
const { saveImpl } = await import('../../src/core/saveImpl');
const { PRESETS, runnerOs } = await import('../../src/core/presets');

const s3 = getTestS3Config();
const runId = `${Date.now()}-${process.pid}`;
let available = false;
let roots: FixtureRoots;
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

async function save(
  values: Record<string, string>,
  state = new MemoryState()
): Promise<Record<string, string>> {
  setInputs(values);
  await saveImpl(state);
  expect(process.exitCode ?? 0).toBe(0);
  return takeOutputs();
}

function onRef(ref: string, baseRef?: string): void {
  process.env.GITHUB_REF = ref;
  if (baseRef) {
    process.env.GITHUB_BASE_REF = baseRef;
  } else {
    delete process.env.GITHUB_BASE_REF;
  }
}

beforeAll(async () => {
  available = await prepareTestBucket(s3);
});

beforeEach(() => {
  roots = {
    workspace: makeTempDir('ws'),
    outside: makeTempDir('outside'),
    home: makeTempDir('home'),
  };
  scratch = makeTempDir('run');
  outputFile = path.join(scratch, 'output.txt');
  fs.writeFileSync(outputFile, '');
  const eventPath = path.join(scratch, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  restoreEnv = setEnv({
    GITHUB_WORKSPACE: roots.workspace,
    HOME: roots.home,
    USERPROFILE: roots.home,
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `cloud-cache-it/${runId}`,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_BASE_REF: undefined,
  });
  compression = { method: 'gzip', archiveFilename: 'cache.tar.gz' };
  // core.setFailed only sets process.exitCode; clear it so one failure cannot fail later tests.
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
  [roots.workspace, roots.outside, roots.home, scratch].forEach(removeDir);
});

describe.each<CompressionConfig & { streaming: boolean }>([
  { method: 'gzip', archiveFilename: 'cache.tar.gz', streaming: false },
  { method: 'gzip', archiveFilename: 'cache.tar.gz', streaming: true },
  { method: 'zstd', archiveFilename: 'cache.tar.zst', streaming: false },
  { method: 'zstd', archiveFilename: 'cache.tar.zst', streaming: true },
])('cache lifecycle with $method (streaming: $streaming)', (config) => {
  itS3(
    'misses, saves, and restores every fixture case exactly',
    async () => {
      if (config.method === 'zstd' && !(await io.which('zstd', false))) {
        console.log('zstd is not installed; skipping the zstd lifecycle.');
        return;
      }
      compression = { method: config.method, archiveFilename: config.archiveFilename };
      const streaming = String(config.streaming);
      const fixture = buildFixtureTree(roots, { largeFileBytes: 12 * 1024 * 1024 });
      const key = `rt-${config.method}-${config.streaming ? 'stream' : 'file'}-${runId}`;
      const paths = fixture.patterns.join('\n');

      const first = await restore({ key, path: paths, streaming });
      expect(first.outputs['cache-hit']).toBe('false');
      expect(await save({ key, path: paths, streaming }, first.state)).toMatchObject({
        'cache-saved-sources': 's3',
      });

      clearFixtureRoots(roots);
      const second = await restore({
        key,
        path: paths,
        'fail-on-cache-miss': 'true',
        streaming,
      });
      expect(second.outputs).toMatchObject({
        'cache-hit': 'true',
        'cache-matched-key': key,
        'cache-hit-source': 's3',
      });
      expect(verifyFixtureTree(fixture, roots)).toEqual([]);
    },
    180_000
  );
});

describe('presets', () => {
  itS3('round-trips the npm cache with the preset path, key and restore-keys', async () => {
    // The preset path of this runner, for example ~/.npm on Linux and ~\AppData\Local\npm-cache
    // on Windows, with ~ replaced by the test home.
    const presetPath = PRESETS.npm.paths[runnerOs()][0];
    const npmCache = path.join(roots.home, ...presetPath.slice(2).split(/[\\/]/));
    writeFiles(roots.workspace, { 'package-lock.json': '{"lockfileVersion":3}' });
    writeFiles(npmCache, { '_cacache/index-v5/aa/bb': 'index', '_cacache/content-v2/x': 'blob' });

    const first = await restore({ preset: 'npm' });
    const key = first.outputs['cache-primary-key'];
    expect(key).toMatch(/^(Linux|macOS|Windows)-npm-[0-9a-f]{64}$/);
    expect(first.outputs['cache-hit']).toBe('false');
    // The post step: the key and the paths come from the restore step's state.
    expect(await save({ preset: 'npm' }, first.state)).toMatchObject({
      'cache-saved-sources': 's3',
    });

    fs.rmSync(npmCache, { recursive: true });
    const second = await restore({ preset: 'npm', 'fail-on-cache-miss': 'true' });
    expect(second.outputs).toMatchObject({ 'cache-hit': 'true', 'cache-matched-key': key });
    expect(fs.readFileSync(path.join(npmCache, '_cacache', 'content-v2', 'x'), 'utf8')).toBe(
      'blob'
    );

    // A changed lockfile gives a new key, and the preset restore-keys find the old cache.
    writeFiles(roots.workspace, { 'package-lock.json': '{"lockfileVersion":3,"x":1}' });
    const third = await restore({ preset: 'npm', 'lookup-only': 'true' });
    expect(third.outputs['cache-primary-key']).not.toBe(key);
    expect(third.outputs).toMatchObject({ 'cache-hit': 'false', 'cache-matched-key': key });
  });
});

describe('key matching', () => {
  itS3('matches by primary-key prefix and by restore-keys', async () => {
    writeFiles(roots.workspace, { 'data/v1.txt': 'one' });
    await save({ key: `pfx-${runId}-v1`, path: 'data' });
    fs.rmSync(path.join(roots.workspace, 'data'), { recursive: true });

    const byPrefix = await restore({ key: `pfx-${runId}-v`, path: 'data' });
    expect(byPrefix.outputs).toMatchObject({
      'cache-hit': 'false',
      'cache-matched-key': `pfx-${runId}-v1`,
    });
    expect(fs.readFileSync(path.join(roots.workspace, 'data', 'v1.txt'), 'utf8')).toBe('one');

    const byRestoreKey = await restore({
      key: `other-${runId}`,
      'restore-keys': `nothing-${runId}-\npfx-${runId}-`,
      path: 'data',
      'lookup-only': 'true',
    });
    expect(byRestoreKey.outputs).toMatchObject({
      'cache-hit': 'false',
      'cache-matched-key': `pfx-${runId}-v1`,
    });
  });

  itS3('restores keys that contain slashes', async () => {
    writeFiles(roots.workspace, { 'data/slash.txt': 'slash' });
    await save({ key: `slash/${runId}/v1`, path: 'data' });
    const result = await restore({
      key: `slash/${runId}/v2`,
      'restore-keys': `slash/${runId}/`,
      path: 'data',
      'lookup-only': 'true',
    });
    expect(result.outputs['cache-matched-key']).toBe(`slash/${runId}/v1`);
  });

  itS3('treats a different path list as a different cache', async () => {
    writeFiles(roots.workspace, { 'data/a.txt': 'a', 'other/b.txt': 'b' });
    await save({ key: `ver-${runId}`, path: 'data' });
    const result = await restore({
      key: `ver-${runId}`,
      path: 'data\nother',
      'lookup-only': 'true',
    });
    expect(result.outputs['cache-hit']).toBe('false');
    expect(result.outputs['cache-matched-key']).toBeUndefined();
  });
});

describe('ref scoping', () => {
  const readData = (): string =>
    fs.readFileSync(path.join(roots.workspace, 'data', 'f.txt'), 'utf8');

  itS3("keeps a branch's cache away from main but lets other branches use main's", async () => {
    writeFiles(roots.workspace, { 'data/f.txt': 'feature' });
    onRef('refs/heads/feature');
    await save({ key: `ref-${runId}`, path: 'data' });

    onRef('refs/heads/main');
    expect(
      (await restore({ key: `ref-${runId}`, path: 'data', 'lookup-only': 'true' })).outputs[
        'cache-hit'
      ]
    ).toBe('false');
    writeFiles(roots.workspace, { 'data/f.txt': 'main' });
    await save({ key: `ref-${runId}`, path: 'data' });

    fs.rmSync(path.join(roots.workspace, 'data'), { recursive: true });
    onRef('refs/heads/feature-2');
    expect((await restore({ key: `ref-${runId}`, path: 'data' })).outputs['cache-hit']).toBe(
      'true'
    );
    expect(readData()).toBe('main');
  });

  itS3('lets a pull request restore from its base branch', async () => {
    writeFiles(roots.workspace, { 'data/f.txt': 'release' });
    onRef('refs/heads/release');
    await save({ key: `pr-${runId}`, path: 'data' });

    fs.rmSync(path.join(roots.workspace, 'data'), { recursive: true });
    onRef('refs/pull/7/merge', 'release');
    expect((await restore({ key: `pr-${runId}`, path: 'data' })).outputs['cache-hit']).toBe('true');
    expect(readData()).toBe('release');
  });

  itS3('shares caches across refs when scoped-to-ref is false', async () => {
    writeFiles(roots.workspace, { 'data/f.txt': 'shared' });
    onRef('refs/heads/feature');
    await save({ key: `shared-${runId}`, path: 'data', 'scoped-to-ref': 'false' });

    fs.rmSync(path.join(roots.workspace, 'data'), { recursive: true });
    onRef('refs/heads/main');
    expect(
      (await restore({ key: `shared-${runId}`, path: 'data', 'scoped-to-ref': 'false' })).outputs[
        'cache-hit'
      ]
    ).toBe('true');
    expect(readData()).toBe('shared');
  });
});
