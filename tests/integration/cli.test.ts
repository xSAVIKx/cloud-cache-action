import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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
  /** The content of the Bitbucket variables file, when the run had one. */
  variables: string;
}

interface CliOptions {
  /** The working directory. The default is the shared work directory. */
  cwd?: string;
  /** The env added to the clean env. The default is the generic CLOUD_CACHE_* ref setup. */
  env?: Record<string, string>;
  /** The file for BITBUCKET_PIPELINES_VARIABLES_PATH. It is emptied before the run. */
  variablesFile?: string;
}

/** The parent env without the variables the CLI reads, so a developer's setup cannot leak in. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(CLOUD_CACHE_|AWS_|GITHUB_|RUNNER_|BITBUCKET_)/.test(name)) {
      delete env[name];
    }
  }
  return env;
}

/** Runs the built CLI bundle in the work directory, as a user of the CLI would. */
async function cli(command: string, flags: string[], options: CliOptions = {}): Promise<CliResult> {
  fs.writeFileSync(outputsFile, '');
  if (options.variablesFile) {
    fs.writeFileSync(options.variablesFile, '');
  }
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
      cwd: options.cwd ?? work,
      env: {
        ...cleanEnv(),
        ...(options.env ?? {
          CLOUD_CACHE_REPOSITORY: repository,
          CLOUD_CACHE_REF: 'main',
          CLOUD_CACHE_WORKSPACE: work,
        }),
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
  const variables = options.variablesFile ? fs.readFileSync(options.variablesFile, 'utf8') : '';
  return { code, log, outputs, variables };
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

  describe('on Bitbucket Pipelines', () => {
    let bbRepo: string;
    let clone: string;
    let varsFile: string;

    /** Runs the CLI as a Bitbucket step: the workspace is BITBUCKET_CLONE_DIR, not a flag. */
    function bbCli(
      command: string,
      flags: string[],
      bbEnv: Record<string, string>
    ): Promise<CliResult> {
      return cli(command, flags, {
        cwd: clone,
        variablesFile: varsFile,
        env: {
          BITBUCKET_BUILD_NUMBER: '1',
          BITBUCKET_CLONE_DIR: clone,
          BITBUCKET_REPO_FULL_NAME: bbRepo,
          BITBUCKET_PIPELINES_VARIABLES_PATH: varsFile,
          ...bbEnv,
        },
      });
    }

    async function listBbObjects(): Promise<string[]> {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: `${bbRepo}/` })
      );
      return (listed.Contents ?? []).map((o) => o.Key ?? '');
    }

    beforeEach(() => {
      bbRepo = `it-ws/${runId}-${Math.random().toString(36).slice(2, 8)}`;
      clone = makeTempDir('cli-bb');
      varsFile = path.join(clone, 'pipelines-variables.txt');
      writeFiles(clone, { 'pom.xml': '<project/>', 'payload/a.txt': 'alpha' });
      fs.rmSync(stateFile, { force: true });
    });

    afterEach(async () => {
      if (available) {
        const keys = await listBbObjects();
        if (keys.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: s3.bucket,
              Delete: { Objects: keys.map((k) => ({ Key: k })) },
            })
          );
        }
      }
      removeDir(clone);
    });

    itS3(
      'saves a PR build under its PR ref and restores the destination branch cache',
      async () => {
        const flags = ['--key', 'mvn-{hash:pom.xml}', '--path', 'payload'];
        const branch = { BITBUCKET_BRANCH: 'develop' };

        const first = await bbCli('restore', flags, branch);
        expect(first.code).toBe(0);
        expect(first.outputs['cache-hit']).toBe('false');
        expect(first.log).not.toContain('::debug::');
        const saved = await bbCli('save', flags, branch);
        expect(saved.code).toBe(0);
        const developKey = saved.outputs['cache-s3-key'];
        expect(developKey).toBeTruthy();
        expect(developKey).toContain('refs%2Fheads%2Fdevelop');

        fs.rmSync(path.join(clone, 'payload'), { recursive: true, force: true });
        const pr = {
          BITBUCKET_BRANCH: 'feature/x',
          BITBUCKET_PR_ID: '5',
          BITBUCKET_PR_DESTINATION_BRANCH: 'develop',
        };
        // The PR changes pom.xml, so its own key misses. The restore key finds the develop entry.
        fs.writeFileSync(path.join(clone, 'pom.xml'), '<project>changed</project>');
        const prFlags = [...flags, '--restore-keys', 'mvn-'];
        const restored = await bbCli('restore', prFlags, pr);
        expect(restored.code).toBe(0);
        expect(restored.outputs['cache-hit']).toBe('false');
        expect(restored.outputs['cache-matched-key']).toMatch(/^mvn-/);
        expect(restored.log).toContain('refs/heads/develop');
        expect(fs.readFileSync(path.join(clone, 'payload', 'a.txt'), 'utf8')).toBe('alpha');

        const prSave = await bbCli('save', prFlags, pr);
        expect(prSave.code).toBe(0);
        const prKey = prSave.outputs['cache-s3-key'];
        expect(prKey).toContain('refs%2Fpull%2F5%2Fmerge');
        expect(prKey).not.toBe(developKey);
        expect(await listBbObjects()).toContain(prKey);
      }
    );

    itS3('writes a metrics record with runner labels', async () => {
      const result = await bbCli('restore', ['--key', 'm', '--path', 'payload'], {
        BITBUCKET_BRANCH: 'main',
        BITBUCKET_STEP_SIZE: '2x',
      });
      expect(result.code).toBe(0);
      const lines = fs
        .readFileSync(path.join(clone, 'cloud-cache-metrics.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
      expect(lines.length).toBeGreaterThan(0);
      const record = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      expect(record.platform).toBe('bitbucket');
      expect(record.runner).toEqual(expect.objectContaining({ stepSize: '2x' }));
      expect(record).toHaveProperty('compression');
    });

    itS3('skips the save after a failed script', async () => {
      const result = await bbCli('save', ['--key', 'failed', '--path', 'payload'], {
        BITBUCKET_BRANCH: 'main',
        BITBUCKET_EXIT_CODE: '1',
      });
      expect(result.code).toBe(0);
      expect(result.log).toContain('Use --save-on-failure to save anyway.');
      expect(result.outputs['cache-s3-key']).toBeUndefined();
      expect(await listBbObjects()).toHaveLength(0);
    });

    itS3('writes output variables for later steps', async () => {
      const result = await bbCli('restore', ['--key', 'vars', '--path', 'payload'], {
        BITBUCKET_BRANCH: 'main',
      });
      expect(result.code).toBe(0);
      expect(result.variables).toMatch(/^CLOUD_CACHE_CACHE_HIT=false$/m);
    });
  });
});
