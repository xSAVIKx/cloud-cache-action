import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolLookup } from '../../../src/archive/commands';
import { BUSYBOX_TAR_ERROR, checkTar } from '../../../src/cli/tarCheck';

// The fake tar is a POSIX shell script, and Windows cannot run it. The lookup that the tests pass
// fixes the platform, so these tests do not depend on the tar of the runner.
const posixIt = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tar-check-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a fake tar that prints `output` to stderr and exits with `code`. */
function fakeTar(name: string, output: string, code: number): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}' >&2\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

function lookup(platform: NodeJS.Platform, tools: Record<string, string>): ToolLookup {
  return {
    platform,
    env: {},
    which: async (tool) => tools[tool] ?? '',
    exists: (file) => existsSync(file),
  };
}

const BUSYBOX_OUTPUT =
  "tar: unrecognized option '--version' BusyBox v1.36.1 (2024-06-10) multi-call binary.";

describe('checkTar', () => {
  posixIt('busybox tar fails with an apk hint', async () => {
    const tar = fakeTar('busybox-tar', BUSYBOX_OUTPUT, 1);
    expect(BUSYBOX_TAR_ERROR).toBe(
      'BusyBox tar is not supported. Install GNU tar and zstd, for example: apk add tar zstd'
    );
    await expect(checkTar(lookup('linux', { tar }))).rejects.toThrow(BUSYBOX_TAR_ERROR);
  });

  posixIt('GNU tar passes the tar check', async () => {
    const tar = fakeTar('gnu-tar', 'tar (GNU tar) 1.35', 0);
    await expect(checkTar(lookup('linux', { tar }))).resolves.toBeUndefined();
  });

  posixIt('checks the tar that the archive code picks', async () => {
    // On macOS the archive code prefers gtar, so a BusyBox tar on PATH does not matter.
    const tar = fakeTar('mac-busybox-tar', BUSYBOX_OUTPUT, 1);
    const gtar = fakeTar('gtar', 'tar (GNU tar) 1.35', 0);
    await expect(checkTar(lookup('darwin', { tar, gtar }))).resolves.toBeUndefined();
  });

  it('a missing tar passes, so the archive code reports it later', async () => {
    await expect(checkTar(lookup('linux', {}))).resolves.toBeUndefined();
  });
});
