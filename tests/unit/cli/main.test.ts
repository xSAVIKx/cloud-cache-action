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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CiHost } from '../../../src/ci/host';
import type { IStateProvider } from '../../../src/state';

const restoreImpl = jest.fn<(state: IStateProvider, earlyExit?: boolean) => Promise<unknown>>();
const saveImpl = jest.fn<(state: IStateProvider) => Promise<unknown>>();
const inspectImpl = jest.fn<() => Promise<void>>();
const pruneImpl = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../../src/core/restoreImpl', () => ({ restoreImpl }));
jest.unstable_mockModule('../../../src/core/saveImpl', () => ({ saveImpl }));
jest.unstable_mockModule('../../../src/core/inspectImpl', () => ({ inspectImpl }));
jest.unstable_mockModule('../../../src/core/pruneImpl', () => ({ pruneImpl }));

const { main } = await import('../../../src/cli/main');
const { checkTar } = await import('../../../src/cli/tarCheck');
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

/** Puts a fake `tar` first on PATH. It prints `output` and exits with `code`. */
function fakeTar(output: string, code: number): void {
  const bin = mkdtempSync(join(dir, 'bin-'));
  const tar = join(bin, 'tar');
  writeFileSync(tar, `#!/bin/sh\necho '${output}' >&2\nexit ${code}\n`);
  chmodSync(tar, 0o755);
  process.env.PATH = `${bin}:${savedEnv.PATH ?? ''}`;
}

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
    expect(stdout).toContain('CLOUD_CACHE_');
    expect(stderr).toBe('');
  });

  it('prints the version', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(stdout).toBe('0.0.0-dev\n');
  });

  it('busybox tar fails with an apk hint', async () => {
    fakeTar(
      "tar: unrecognized option '--version'\nBusyBox v1.36.1 (2024-06-10) multi-call binary.",
      1
    );
    await expect(checkTar()).rejects.toThrow(BUSYBOX_ERROR);

    expect(await main(['restore', '--key', 'k', '--path', 'p'])).toBe(1);
    expect(stderr).toContain(`error: ${BUSYBOX_ERROR}`);
    expect(restoreImpl).not.toHaveBeenCalled();
    // inspect does not run tar, so it does not check it.
    expect(await main(['inspect'])).toBe(0);
  });

  it('GNU tar passes the tar check', async () => {
    fakeTar('tar (GNU tar) 1.35', 0);
    await expect(checkTar()).resolves.toBeUndefined();
  });
});
