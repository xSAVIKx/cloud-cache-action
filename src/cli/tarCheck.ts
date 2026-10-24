import { execFile } from 'node:child_process';
import { findTar, type ToolLookup } from '../archive/commands';

export const BUSYBOX_TAR_ERROR =
  'BusyBox tar is not supported. Install GNU tar and zstd, for example: apk add tar zstd';

/** Runs `<tar> --version` and returns stdout and stderr. A failure to run gives ''. */
function versionText(tar: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(tar, ['--version'], { timeout: 10_000 }, (_error, stdout, stderr) => {
      resolve(`${stdout ?? ''}${stderr ?? ''}`);
    });
  });
}

/**
 * Fails when the tar that the archive code picks is BusyBox tar. When tar is missing, this check
 * passes, and the archive code reports the missing tar later. `lookup` replaces the system lookup
 * of findTar, for tests.
 */
export async function checkTar(lookup?: ToolLookup): Promise<void> {
  let tar: string;
  try {
    tar = (await findTar(lookup)).path;
  } catch {
    return;
  }
  if ((await versionText(tar)).includes('BusyBox')) {
    throw new Error(BUSYBOX_TAR_ERROR);
  }
}
