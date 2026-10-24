import { jest } from '@jest/globals';
import type { CiHost } from '../../../src/ci/host';

const INPUTS: Record<string, string> = {
  key: 'deps-1',
  path: 'node_modules',
  bucket: 'context-bucket',
  region: 'us-east-1',
  'access-key-id': 'context',
  'secret-access-key': 'context',
};
jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => INPUTS[name] ?? '',
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));

const { setHost } = await import('../../../src/ci/host');
const { readCacheConfig } = await import('../../../src/core/config');
const { buildS3Tier } = await import('../../../src/core/s3Tier');

function testHost(): CiHost {
  const noop = (): void => undefined;
  return {
    context: () => ({
      platform: 'generic',
      repository: 'acme/repo',
      refs: { current: 'refs/heads/x', restore: ['refs/heads/x'] },
      workspace: '/ws',
      homeDir: '/home/ci',
      runnerOs: 'Linux',
      env: {},
    }),
    input: (name) => INPUTS[name] ?? '',
    setOutput: noop,
    setFailed: noop,
    state: { getState: () => '', setState: noop, getCacheState: () => '' },
    log: {
      debug: noop,
      info: noop,
      warning: noop,
      error: noop,
      startGroup: noop,
      endGroup: noop,
    },
  };
}

afterEach(() => {
  setHost(undefined);
});

describe('S3 tier reads the CI context', () => {
  it('takes the repository, refs and workspace from the host, not from GITHUB_* variables', async () => {
    setHost(testHost());

    const tier = await buildS3Tier(readCacheConfig(), undefined, { compression: 'zstd' });

    expect(tier.restoreRefs).toEqual(['refs/heads/x']);
    expect(tier.saveRef).toBe('refs/heads/x');
    expect(tier.workspace).toBe('/ws');
    expect(tier.template.objectKey(tier.saveRef, 'deps-1')).toContain('acme/repo');
  });
});
