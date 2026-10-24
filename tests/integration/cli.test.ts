import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTestS3Client, getTestS3Config, prepareTestBucket } from '../support/s3Server';
import { makeTempDir, removeDir, writeFiles } from '../support/tempTree';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = path.join(repoRoot, 'build', 'cli', 'cloud-cache.mjs');

const s3 = getTestS3Config();
const runId = `${Date.now()}-${process.pid}`;
const repository = `cli-it/${runId}`;
const client = createTestS3Client(s3);
let available = false;
let work: string;
let outputsFile: string;
let stateFile: string;

interface CliResult {
  code: number;
  log: string;
  outputs: Record<string, string>;
}

/** The parent env without the variables the CLI reads, so a developer's setup cannot leak in. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(CLOUD_CACHE_|AWS_|GITHUB_|RUNNER_)/.test(name)) {
      delete env[name];
    }
  }
  return env;
}

/** Runs the built CLI bundle in the work directory, as a user of the CLI would. */
async function cli(command: string, flags: string[]): Promise<CliResult> {
  fs.writeFileSync(outputsFile, '');
  const args = [
    bundle,
    command,
    '--bucket',
    s3.bucket,
    '--endpoint',
    s3.endpoint,
    '--region',
    s3.region,
    '--provider',
    s3.provider,
    '--access-key',
    s3.accessKeyId,
    '--secret-key',
    s3.secretAccessKey,
    '--force-path-style',
    '--retry=false',
    '--state-file',
    stateFile,
    '--outputs-file',
    outputsFile,
    ...flags,
  ];
  let code = 0;
  let log: string;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: work,
      env: {
        ...cleanEnv(),
        CLOUD_CACHE_REPOSITORY: repository,
        CLOUD_CACHE_REF: 'main',
        CLOUD_CACHE_WORKSPACE: work,
      },
    });
    log = stdout + stderr;
  } catch (err: unknown) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    code = typeof failure.code === 'number' ? failure.code : 1;
    log = (failure.stdout ?? '') + (failure.stderr ?? '');
  }
  const outputs: Record<string, string> = {};
  for (const line of fs.readFileSync(outputsFile, 'utf8').split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) {
      outputs[line.slice(0, split)] = line.slice(split + 1);
    }
  }
  return { code, log, outputs };
}

async function listObjects(): Promise<{ key: string }[]> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: `${repository}/` })
  );
  return (listed.Contents ?? []).map((o) => ({ key: o.Key ?? '' }));
}

async function headObject(key: string): Promise<{ etag?: string; modified?: Date }> {
  const head = await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
  return { etag: head.ETag, modified: head.LastModified };
}

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

// The bundle is a build product. Build it when it is missing, so a plain "npm test" works.
async function ensureBundle(): Promise<void> {
  if (fs.existsSync(bundle)) {
    return;
  }
  await execFileAsync('npm', ['run', 'build:cli'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
  });
  if (!fs.existsSync(bundle)) {
    throw new Error(`${bundle} is missing after "npm run build:cli".`);
  }
}

// Only the `cli` CI job sets TEST_CLI. Runs on Windows and macOS come with the per-OS binaries later.
const describeCli = process.env.TEST_CLI === '1' ? describe : describe.skip;

describeCli('cloud-cache CLI bundle against S3', () => {
  const key = `cli-${runId}`;

  beforeAll(async () => {
    available = await prepareTestBucket(s3);
    if (available) {
      await ensureBundle();
    }
    work = makeTempDir('cli');
    outputsFile = path.join(work, 'outputs.txt');
    stateFile = path.join(work, 'state.json');
    writeFiles(path.join(work, 'payload'), { 'a.txt': 'alpha', 'sub/b.txt': 'beta' });
  }, 120_000);

  afterAll(async () => {
    if (available) {
      const objects = await listObjects();
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: s3.bucket,
            Delete: { Objects: objects.map((o) => ({ Key: o.key })) },
          })
        );
      }
    }
    client.destroy();
    if (work) {
      removeDir(work);
    }
  });

  itS3('restore misses on an empty cache and exits 0', async () => {
    const result = await cli('restore', ['--key', key, '--path', 'payload']);
    expect(result.code).toBe(0);
    expect(result.outputs['cache-hit']).toBe('false');
    expect(await listObjects()).toHaveLength(0);
  });

  itS3('restore with --fail-on-cache-miss exits non-zero on a miss', async () => {
    const result = await cli('restore', [
      '--key',
      `${key}-absent`,
      '--path',
      'payload',
      '--fail-on-cache-miss',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.log).toContain(
      `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${key}-absent`
    );
  });

  itS3('save uploads the archive', async () => {
    // Save takes the key from the state of the last restore, and the failed restore above wrote
    // another key. Restore this key first.
    await cli('restore', ['--key', key, '--path', 'payload']);
    const result = await cli('save', ['--key', key, '--path', 'payload']);
    expect(result.code).toBe(0);
    const objects = await listObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toContain(`/${key}/`);
  });

  itS3('restore hits after a save and restores the files', async () => {
    fs.rmSync(path.join(work, 'payload'), { recursive: true, force: true });
    const result = await cli('restore', ['--key', key, '--path', 'payload']);
    expect(result.code).toBe(0);
    expect(result.outputs['cache-hit']).toBe('true');
    expect(result.outputs['cache-matched-key']).toBe(key);
    expect(fs.readFileSync(path.join(work, 'payload', 'a.txt'), 'utf8')).toBe('alpha');
    expect(fs.readFileSync(path.join(work, 'payload', 'sub', 'b.txt'), 'utf8')).toBe('beta');
  });

  itS3('save skips after an exact restore hit', async () => {
    const [object] = await listObjects();
    const before = await headObject(object.key);
    // The state file now holds the hit of the previous restore, from another process.
    const result = await cli('save', ['--key', key, '--path', 'payload']);
    expect(result.code).toBe(0);
    expect(result.log).toContain(`Cache hit occurred on the primary key ${key}, not saving cache.`);
    const after = await headObject(object.key);
    expect(after.etag).toBe(before.etag);
    expect(after.modified?.getTime()).toBe(before.modified?.getTime());
    expect(await listObjects()).toHaveLength(1);
  });

  itS3('save uploads a new key after a hit on another key', async () => {
    const other = `${key}-2`;
    const hit = await cli('restore', ['--key', key, '--path', 'payload']);
    expect(hit.outputs['cache-hit']).toBe('true');
    // The hit on the first key must not stay in the state file.
    const miss = await cli('restore', ['--key', other, '--path', 'payload']);
    expect(miss.code).toBe(0);
    expect(miss.outputs['cache-hit']).toBe('false');

    const result = await cli('save', ['--key', other, '--path', 'payload']);
    expect(result.code).toBe(0);
    expect(result.log).not.toContain('not saving cache');
    const objects = await listObjects();
    expect(objects).toHaveLength(2);
    expect(objects.some((o) => o.key.includes(`/${other}/`))).toBe(true);
  });
});
