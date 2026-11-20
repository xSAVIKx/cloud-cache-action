import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { State } from '../../../src/constants';
import type { CacheConfig } from '../../../src/core/config';
import type { SaveOutcome } from '../../../src/core/outcomes';
import type { S3Tier } from '../../../src/core/s3Tier';

// The real saveImpl runs. Only the S3 calls, the summary and the metrics are mocked.
const buildS3Tier =
  jest.fn<(config: CacheConfig, env?: NodeJS.ProcessEnv, options?: object) => Promise<S3Tier>>();
const saveToS3 =
  jest.fn<(tier: S3Tier, key: string, paths: readonly string[]) => Promise<SaveOutcome>>();
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({ buildS3Tier, saveToS3 }));
jest.unstable_mockModule('../../../src/core/summary', () => ({ writeSaveSummary: async () => {} }));
jest.unstable_mockModule('../../../src/core/metrics', () => ({
  emitMetrics: () => {},
  hostMetricsFields: () => ({}),
}));

const { saveImpl } = await import('../../../src/core/saveImpl');
const { applySaveFlags } = await import('../../../src/cli/saveFlags');
const { setHost } = await import('../../../src/ci/host');
const { GenericHost } = await import('../../../src/ci/generic');
const { FileStateProvider } = await import('../../../src/ci/stateFile');
const { INPUT_DEFAULTS } = await import('../../../src/cli/defaults');

const dir = mkdtempSync(join(tmpdir(), 'save-flags-'));
const stateFile = join(dir, 'state.json');
const tier = {
  storage: { providerConfig: { provider: 'seaweedfs', region: 'eu-west-1' } },
  compression: { method: 'gzip', archiveFilename: 'cache.tgz' },
} as unknown as S3Tier;
let stderr = '';
const savedEnv = { ...process.env };

beforeEach(() => {
  buildS3Tier.mockReset().mockResolvedValue(tier);
  saveToS3
    .mockReset()
    .mockResolvedValue({ kind: 'saved', s3: { objectKey: 'o/r/ci/k', size: 1, etag: '"e"' } });
  stderr = '';
  jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.env = { ...savedEnv, CLOUD_CACHE_REPOSITORY: 'o/r' };
});
afterEach(() => {
  process.env = { ...savedEnv };
  process.exitCode = undefined;
  setHost(undefined);
  jest.restoreAllMocks();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('applySaveFlags with the real save', () => {
  it('save --prefix after a restore without a prefix uploads under the new prefix', async () => {
    // This is what restore writes after an exact hit with the default, empty prefix.
    const restored = {
      [State.CachePrimaryKey]: 'k',
      [State.CachePaths]: '["data"]',
      [State.CachePrefix]: '',
      [State.CacheS3ExactHit]: 'true',
    };
    writeFileSync(stateFile, JSON.stringify(restored));
    const flags = { key: 'k', path: 'data', prefix: 'ci/' };
    setHost(new GenericHost({ inputs: flags, defaults: INPUT_DEFAULTS.save, stateFile }));
    const state = new FileStateProvider(stateFile);

    applySaveFlags(state, flags, stateFile);
    await saveImpl(state);

    expect(stderr).toContain(
      'warning: The flags --prefix differ from the values in the state file'
    );
    expect(buildS3Tier).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'ci/' }),
      expect.anything(),
      expect.anything()
    );
    // The exact hit of restore was for the object without the prefix, so save uploads.
    expect(saveToS3).toHaveBeenCalledWith(tier, 'k', ['data']);
    expect(process.exitCode).toBeUndefined();
    // The state file keeps the values of restore.
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual(restored);
  });

  it('without the flag, the exact hit of restore still skips the upload', async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        [State.CachePrimaryKey]: 'k',
        [State.CachePaths]: '["data"]',
        [State.CachePrefix]: '',
        [State.CacheS3ExactHit]: 'true',
      })
    );
    const flags = { key: 'k', path: 'data' };
    setHost(new GenericHost({ inputs: flags, defaults: INPUT_DEFAULTS.save, stateFile }));
    const state = new FileStateProvider(stateFile);

    applySaveFlags(state, flags, stateFile);
    await saveImpl(state);

    expect(stderr).not.toContain('The flags');
    expect(saveToS3).not.toHaveBeenCalled();
  });
});
