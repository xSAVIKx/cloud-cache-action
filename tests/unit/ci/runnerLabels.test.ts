import { describe, expect, it } from '@jest/globals';
import * as os from 'node:os';
import { runnerLabels } from '../../../src/ci/runnerLabels';

const V2 = '/sys/fs/cgroup/memory.max';
const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

function files(map: Record<string, string>): (file: string) => string {
  return (file) => {
    if (file in map) return map[file];
    throw new Error(`ENOENT: ${file}`);
  };
}

describe('runnerLabels', () => {
  it('reads the step size', () => {
    expect(runnerLabels({ BITBUCKET_STEP_SIZE: '2x' }, files({})).stepSize).toBe('2x');
  });

  it('uses unknown when the step size is absent', () => {
    expect(runnerLabels({}, files({})).stepSize).toBe('unknown');
  });

  it('reports the available CPU count', () => {
    expect(runnerLabels({}, files({})).cpus).toBe(os.availableParallelism());
  });

  it('reads the cgroup v2 memory limit', () => {
    expect(runnerLabels({}, files({ [V2]: '4294967296\n' })).memoryLimitBytes).toBe(4294967296);
  });

  it('falls back to cgroup v1 when v2 says max', () => {
    const read = files({ [V2]: 'max\n', [V1]: '2147483648\n' });
    expect(runnerLabels({}, read).memoryLimitBytes).toBe(2147483648);
  });

  it('falls back to cgroup v1 when v2 cannot be read', () => {
    expect(runnerLabels({}, files({ [V1]: '1073741824' })).memoryLimitBytes).toBe(1073741824);
  });

  it('leaves the limit out when no file gives one', () => {
    const labels = runnerLabels({}, files({ [V2]: 'max' }));
    expect(labels.memoryLimitBytes).toBeUndefined();
    expect('memoryLimitBytes' in labels).toBe(false);
  });
});
