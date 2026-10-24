import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CiHost } from '../../../src/ci/host';
import { State } from '../../../src/constants';
import type { IStateProvider } from '../../../src/state';

const restoreImpl = jest.fn<(state: IStateProvider, earlyExit?: boolean) => Promise<unknown>>();
const saveImpl = jest.fn<(state: IStateProvider) => Promise<unknown>>();
const inspectImpl = jest.fn<() => Promise<void>>();
const pruneImpl = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../../src/core/restoreImpl', () => ({ restoreImpl }));
jest.unstable_mockModule('../../../src/core/saveImpl', () => ({ saveImpl }));
jest.unstable_mockModule('../../../src/core/inspectImpl', () => ({ inspectImpl }));
jest.unstable_mockModule('../../../src/core/pruneImpl', () => ({ pruneImpl }));
// The real check runs the system tar, which differs per runner OS. tarCheck.test.ts tests it.
const checkTar = jest.fn<() => Promise<void>>();
jest.unstable_mockModule('../../../src/cli/tarCheck', () => ({ checkTar }));

const { main } = await import('../../../src/cli/main');
const { getHost, setHost } = await import('../../../src/ci/host');
const { GenericHost } = await import('../../../src/ci/generic');
const { FileStateProvider } = await import('../../../src/ci/stateFile');

const BUSYBOX_ERROR =
  'BusyBox tar is not supported. Install GNU tar and zstd, for example: apk add tar zstd';

let dir: string;
let stdout: string;
let stderr: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-main-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const mock of [restoreImpl, saveImpl, inspectImpl, pruneImpl, checkTar]) {
    mock.mockReset();
  }
  stdout = '';
  stderr = '';
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.env = { ...savedEnv, CLOUD_CACHE_STATE_FILE: join(dir, 'state.json') };
});
afterEach(() => {
  process.env = { ...savedEnv };
  process.exitCode = undefined;
  setHost(undefined);
  jest.restoreAllMocks();
});

describe('main', () => {
  it('cli sets the generic host before it runs a command', async () => {
    const seen: CiHost[] = [];
    let key = '';
    for (const impl of [restoreImpl, saveImpl, inspectImpl, pruneImpl]) {
      impl.mockImplementation(async () => {
        seen.push(getHost());
        key = getHost().input('key');
        return undefined;
      });
    }
    process.env.CLOUD_CACHE_KEY = 'env-key';

    expect(await main(['restore', '--path', 'a'])).toBe(0);
    expect(key).toBe('env-key');
    expect(await main(['save', '--key', 'flag-key'])).toBe(0);
    expect(key).toBe('flag-key');
    expect(await main(['inspect'])).toBe(0);
    expect(await main(['prune'])).toBe(0);

    expect(seen).toHaveLength(4);
    for (const host of seen) {
      expect(host).toBeInstanceOf(GenericHost);
    }
    expect(restoreImpl).toHaveBeenCalledWith(expect.any(FileStateProvider), false);
    expect(saveImpl).toHaveBeenCalledWith(expect.any(FileStateProvider));
    expect(inspectImpl).toHaveBeenCalledWith();
    expect(pruneImpl).toHaveBeenCalledWith();
  });

  it('exit code follows process.exitCode', async () => {
    inspectImpl.mockImplementation(async () => {
      getHost().setFailed('no bucket');
    });
    expect(await main(['inspect'])).toBe(1);
    expect(stderr).toContain('error: no bucket');

    process.exitCode = undefined;
    inspectImpl.mockImplementation(async () => {});
    expect(await main(['inspect'])).toBe(0);

    pruneImpl.mockImplementation(async () => {
      throw new Error('unexpected');
    });
    expect(await main(['prune'])).toBe(1);
    expect(stderr).toContain('error: unexpected');
  });

  it('usage errors exit 2 with the usage text on stderr', async () => {
    expect(await main(['restore', '--nope'])).toBe(2);
    expect(stderr).toContain('error: unknown flag --nope');
    expect(stderr).toContain('Usage: cloud-cache <command> [flags]');
    expect(restoreImpl).not.toHaveBeenCalled();
  });

  it('help lists commands, flags with defaults, and the env rule', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(stdout).toContain('Usage: cloud-cache <command> [flags]');
    for (const command of ['restore', 'save', 'inspect', 'prune']) {
      expect(stdout).toContain(command);
    }
    expect(stdout).toContain('--retry-count <value>  (default: 3)');
    expect(stdout).toContain('--max-candidates');
    expect(stdout).toContain('--state-file');
    expect(stdout).toContain('name<<delimiter');
    expect(stdout).toContain('CLOUD_CACHE_');
    expect(stderr).toBe('');
  });

  it('prints the version', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(stdout).toBe('0.0.0-dev\n');
  });

  it('restore starts from an empty state file', async () => {
    const stateFile = join(dir, 'state.json');
    const old = { [State.CachePrimaryKey]: 'k1', [State.CacheS3ExactHit]: 'true' };
    writeFileSync(stateFile, JSON.stringify(old));
    const seen: string[] = [];
    restoreImpl.mockImplementation(async (state) => {
      seen.push(state.getState(State.CachePrimaryKey), state.getState(State.CacheS3ExactHit));
      return undefined;
    });

    expect(await main(['restore', '--key', 'k2', '--path', 'p'])).toBe(0);
    expect(seen).toEqual(['', '']);
  });

  it('save warns when the key or the paths differ from the state', async () => {
    const stateFile = join(dir, 'state.json');
    const restored = { [State.CachePrimaryKey]: 'k1', [State.CachePaths]: '["a","b"]' };
    writeFileSync(stateFile, JSON.stringify(restored));

    expect(await main(['save', '--key', 'k2', '--path', 'c'])).toBe(0);
    expect(stderr).toContain(
      `warning: The key k2 differs from the key k1 in the state file ${stateFile}.`
    );
    expect(stderr).toContain(
      `warning: The paths c differ from the paths a, b in the state file ${stateFile}.`
    );
    expect(stderr).toContain('The state from restore wins');
    expect(saveImpl).toHaveBeenCalledTimes(1);

    // An env var counts as a value that the user gave.
    stderr = '';
    process.env.CLOUD_CACHE_KEY = 'k3';
    expect(await main(['save'])).toBe(0);
    expect(stderr).toContain('The key k3 differs from the key k1');
    expect(stderr).not.toContain('paths');
    delete process.env.CLOUD_CACHE_KEY;

    // Equal values, no values, or no state give no warning.
    stderr = '';
    expect(await main(['save', '--key', 'k1', '--path', 'a', '--path', 'b'])).toBe(0);
    expect(await main(['save'])).toBe(0);
    rmSync(stateFile);
    expect(await main(['save', '--key', 'k2', '--path', 'c'])).toBe(0);
    expect(stderr).toBe('');
  });

  it('restore and save stop on a busybox tar error', async () => {
    checkTar.mockImplementation(async () => {
      // The check runs after the host is set.
      expect(getHost()).toBeInstanceOf(GenericHost);
      throw new Error(BUSYBOX_ERROR);
    });

    expect(await main(['restore', '--key', 'k', '--path', 'p'])).toBe(1);
    expect(await main(['save', '--key', 'k', '--path', 'p'])).toBe(1);
    expect(stderr).toContain(`error: ${BUSYBOX_ERROR}`);
    expect(restoreImpl).not.toHaveBeenCalled();
    expect(saveImpl).not.toHaveBeenCalled();
    expect(checkTar).toHaveBeenCalledTimes(2);

    // inspect and prune do not run tar, so they do not check it.
    expect(await main(['inspect'])).toBe(0);
    expect(await main(['prune'])).toBe(0);
    expect(checkTar).toHaveBeenCalledTimes(2);
  });
});
