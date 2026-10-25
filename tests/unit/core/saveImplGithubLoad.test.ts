import { jest } from '@jest/globals';
import { Inputs } from '../../../src/constants';
import type { SaveOutcome } from '../../../src/core/outcomes';
import type { S3Tier } from '../../../src/core/s3Tier';
import { MemoryState } from '../../support/memoryState';

// The GitHub tier is a lazy chunk. This file makes the import of that chunk fail, and checks
// that a dual-cache save handles the failure like any other GitHub tier error.

const inputs = new Map<string, string>();
const outputs = new Map<string, string>();
const mockSetFailed = jest.fn<(message: string) => void>(() => {
  process.exitCode = 1;
});
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  setOutput: (name: string, value: string) => outputs.set(name, value),
  setFailed: mockSetFailed,
  info: jest.fn(),
  warning: mockWarning,
  debug: jest.fn(),
  saveState: jest.fn(),
  getState: () => '',
}));
const tier = {
  storage: { providerConfig: { provider: 'seaweedfs', region: 'eu-west-1' } },
  compression: { method: 'gzip', archiveFilename: 'cache.tgz' },
} as unknown as S3Tier;
const s3Saved: SaveOutcome = {
  kind: 'saved',
  s3: { objectKey: 'octo/app/k/cache.tar.zst', size: 2048, etag: '"new"' },
  transferMs: 9,
};
jest.unstable_mockModule('../../../src/core/s3Tier', () => ({
  buildS3Tier: async () => tier,
  saveToS3: async () => s3Saved,
}));
jest.unstable_mockModule('../../../src/core/githubTier', () => {
  throw new Error('Cannot find module ./80.index.js');
});
jest.unstable_mockModule('../../../src/core/summary', () => ({
  writeSaveSummary: async () => {},
}));
jest.unstable_mockModule('../../../src/core/metrics', () => ({
  emitMetrics: () => {},
  hostMetricsFields: () => ({}),
}));

const { saveImpl } = await import('../../../src/core/saveImpl');

describe('saveImpl when the GitHub tier chunk does not load', () => {
  beforeEach(() => {
    inputs.clear();
    outputs.clear();
    jest.clearAllMocks();
    process.env.GITHUB_EVENT_NAME = 'push';
    inputs.set(Inputs.Key, 'Linux-npm-abc');
    inputs.set(Inputs.Path, '~/.npm');
    inputs.set(Inputs.DualCache, 'true');
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('warns and keeps the S3 save when not strict', async () => {
    await saveImpl(new MemoryState());
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Dual-cache GitHub Actions Cache save error:')
    );
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Cannot find module ./80.index.js')
    );
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(outputs.get('cache-saved-sources')).toBe('s3');
  });

  it('fails the step when strict', async () => {
    inputs.set(Inputs.DualCacheStrict, 'true');
    await saveImpl(new MemoryState());
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining('Saving to GitHub Actions Cache failed:')
    );
  });
});
