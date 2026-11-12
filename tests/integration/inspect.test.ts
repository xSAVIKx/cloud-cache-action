import * as fs from 'node:fs';
import * as path from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import type { ExplainReport } from '../../src/core/explain';
import { inspectImpl } from '../../src/core/inspectImpl';
import { saveImpl } from '../../src/core/saveImpl';
import { MemoryState } from '../support/memoryState';
import {
  createTestS3Client,
  deleteTestPrefix,
  getTestS3Config,
  prepareTestBucket,
} from '../support/s3Server';
import { makeTempDir, removeDir, setEnv, writeFiles } from '../support/tempTree';

const s3 = getTestS3Config();
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

beforeAll(async () => {
  available = await prepareTestBucket(s3);
  client = createTestS3Client(s3);
});

afterAll(() => {
  client.destroy();
});

beforeEach(() => {
  workspace = makeTempDir('inspect-ws');
  scratch = makeTempDir('inspect-run');
  outputFile = path.join(scratch, 'output.txt');
  fs.writeFileSync(outputFile, '');
  const eventPath = path.join(scratch, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  restoreEnv = setEnv({
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: `cloud-cache-it/inspect-${runId}`,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_BASE_REF: undefined,
    GITHUB_STEP_SUMMARY: undefined,
  });
  process.exitCode = undefined;
});

afterAll(async () => {
  if (available) {
    await deleteTestPrefix(s3, `cloud-cache-it/inspect-${runId}/`);
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

describe('inspectImpl integration', () => {
  itS3('explains a hit for the key that was saved, and a miss for other paths', async () => {
    const key = `inspect-${runId}`;
    writeFiles(workspace, { 'data/f.txt': 'cached', 'other-dir/f.txt': 'different' });

    setInputs({ key, path: 'data' });
    await saveImpl(new MemoryState());
    expect(process.exitCode ?? 0).toBe(0);
    const savedObjectKey = takeOutputs()['cache-s3-key'];
    expect(savedObjectKey).toBeTruthy();

    setInputs({ key, path: 'data' });
    await inspectImpl();
    expect(process.exitCode ?? 0).toBe(0);
    const hit = takeOutputs();
    expect(hit['would-hit']).toBe('true');
    expect(hit['would-match-key']).toBe(key);
    expect(hit['would-match-object']).toBe(savedObjectKey);
    expect(Number(hit['candidate-count'])).toBeGreaterThan(0);
    expect((JSON.parse(hit.report) as ExplainReport).wouldHit?.objectKey).toBe(savedObjectKey);

    // The same key with different paths hashes to a different ${version}, so nothing matches.
    setInputs({ key, path: 'other-dir' });
    await inspectImpl();
    expect(process.exitCode ?? 0).toBe(0);
    const miss = takeOutputs();
    expect(miss['would-hit']).toBe('false');
    expect(miss['would-match-key']).toBe('');
    expect(miss['would-match-object']).toBe('');
    const report = JSON.parse(miss.report) as ExplainReport;
    expect(report.wouldHit).toBeUndefined();
    expect(report.reasons.join(' ')).toContain(`none has version ${report.version}`);
  });
});
