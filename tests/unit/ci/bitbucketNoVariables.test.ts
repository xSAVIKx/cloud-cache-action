import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const appendFileSync = jest.fn();
const actualFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
jest.unstable_mockModule('node:fs', () => ({ ...actualFs, default: actualFs, appendFileSync }));

const { BitbucketHost } = await import('../../../src/ci/bitbucket');

describe('BitbucketHost without a variables file', () => {
  beforeEach(() => {
    appendFileSync.mockClear();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes no file when the outputs path and the variables path are unset', () => {
    const host = new BitbucketHost({
      inputs: {},
      defaults: {},
      env: { BITBUCKET_BUILD_NUMBER: '1' },
      stateFile: '/nonexistent/state.json',
    });
    host.setOutput('cache-hit', 'true');
    expect(appendFileSync).not.toHaveBeenCalled();
  });

  it('writes only the outputs file when the variables path is unset', () => {
    const host = new BitbucketHost({
      inputs: {},
      defaults: {},
      env: { BITBUCKET_BUILD_NUMBER: '1' },
      stateFile: '/nonexistent/state.json',
      outputsFile: '/o.txt',
    });
    host.setOutput('cache-hit', 'true');
    expect(appendFileSync).toHaveBeenCalledTimes(1);
    expect(appendFileSync).toHaveBeenCalledWith('/o.txt', 'cache-hit=true\n');
  });
});
