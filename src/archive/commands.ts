/**
 * Pure archive command builders. This module has no runtime relative imports, so Node can load it
 * with native type stripping (the compression benchmark does this). Keep it so: a relative import
 * without an extension fails under native Node with ERR_MODULE_NOT_FOUND.
 */
import type { ExecOptions } from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CompressionMethod } from './compression';

export type TarFlavor = 'gnu' | 'bsd';

export interface TarTool {
  path: string;
  flavor: TarFlavor;
}

export interface ArchiveCommand {
  tool: string;
  args: string[];
}

export interface ToolLookup {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Resolves a tool on PATH; '' when absent. */
  which: (tool: string) => Promise<string>;
  exists: (file: string) => boolean;
}

export interface ArchivePlan {
  tar: TarTool;
  platform: NodeJS.Platform;
  compression: CompressionMethod;
  archivePath: string;
  workspace: string;
  /** Scratch directory; BSD tar on Windows writes its intermediate .tar here. */
  tempDir: string;
  /** Compression level for saving; undefined keeps the tool's own default. */
  level?: number;
  /** The zstd long-distance window for saving, as a power of two; undefined means 30. */
  windowLog?: ZstdWindowLog;
}

/**
 * The zstd long-distance window, as a power of two. 30 (1 GiB) is the default, as in
 * actions/cache. 27 (128 MiB) is the fallback for a runner with little memory.
 */
export type ZstdWindowLog = 27 | 30;
export const ZSTD_WINDOW_LOG: ZstdWindowLog = 30;
export const ZSTD_LOW_MEMORY_WINDOW_LOG: ZstdWindowLog = 27;

/**
 * The usable memory below which a save uses the 128 MiB window. With the 1 GiB window, zstd held
 * up to 1.14 GB while it compressed a 1.14 GB tar (165 MB with the 128 MiB window). The upload
 * can take a quarter of the usable memory as well. 1.5 GiB leaves about 1.1 GiB for zstd.
 */
export const ZSTD_WINDOW_MIN_MEMORY = 1.5 * 1024 * 1024 * 1024;

/**
 * The window for a save with `usableMemoryBytes` of usable memory. The restore command always
 * uses `--long=30`, and that decodes an archive with either window. The archive format and the
 * cache version thus stay the same.
 */
export function zstdWindowLog(usableMemoryBytes: number): ZstdWindowLog {
  return usableMemoryBytes < ZSTD_WINDOW_MIN_MEMORY ? ZSTD_LOW_MEMORY_WINDOW_LOG : ZSTD_WINDOW_LOG;
}

const ZSTD_DECOMPRESS = `zstd -d --long=${ZSTD_WINDOW_LOG}`;

function systemLookup(): ToolLookup {
  return {
    platform: process.platform,
    env: process.env,
    which: (tool) => io.which(tool, false),
    exists: (file) => fs.existsSync(file),
  };
}

/** Picks tar the way actions/cache does: GNU tar where available, BSD tar otherwise. */
export async function findTar(lookup: ToolLookup = systemLookup()): Promise<TarTool> {
  if (lookup.platform === 'win32') {
    const programFiles = lookup.env.ProgramFiles || 'C:\\Program Files';
    const gnuTar = path.win32.join(programFiles, 'Git', 'usr', 'bin', 'tar.exe');
    if (lookup.exists(gnuTar)) {
      return { path: gnuTar, flavor: 'gnu' };
    }
    const systemRoot = lookup.env.SystemRoot || 'C:\\Windows';
    const systemTar = path.win32.join(systemRoot, 'System32', 'tar.exe');
    if (lookup.exists(systemTar)) {
      return { path: systemTar, flavor: 'bsd' };
    }
    throw new Error(`tar was not found at ${gnuTar} or ${systemTar}`);
  }

  if (lookup.platform === 'darwin') {
    const gtar = await lookup.which('gtar');
    if (gtar) {
      return { path: gtar, flavor: 'gnu' };
    }
  }

  const tar = await lookup.which('tar');
  if (!tar) {
    throw new Error('tar was not found on PATH');
  }
  return { path: tar, flavor: lookup.platform === 'darwin' ? 'bsd' : 'gnu' };
}

const slashes = (value: string): string => value.replace(/\\/g, '/');

/**
 * BSD tar on Windows cannot pipe through zstd reliably, so zstd runs as its own command. This
 * also means that combination cannot stream (Task 8): callers that want to stream check this
 * first and fall back to a temporary archive file when it is true.
 */
export function usesSeparateZstd(
  plan: Pick<ArchivePlan, 'tar' | 'platform' | 'compression'>
): boolean {
  return plan.tar.flavor === 'bsd' && plan.platform === 'win32' && plan.compression === 'zstd';
}

function platformFlags(plan: ArchivePlan): string[] {
  if (plan.tar.flavor !== 'gnu') {
    return [];
  }
  if (plan.platform === 'win32') {
    return ['--force-local'];
  }
  if (plan.platform === 'darwin') {
    return ['--delay-directory-restore'];
  }
  return [];
}

function zstdCompressProgram(level?: number, windowLog: ZstdWindowLog = ZSTD_WINDOW_LOG): string {
  return level === undefined
    ? `zstd -T0 --long=${windowLog}`
    : `zstd -${level} -T0 --long=${windowLog}`;
}

function compressionFlags(method: CompressionMethod, program: string, level?: number): string[] {
  if (method === 'zstd') {
    return ['--use-compress-program', program];
  }
  return level === undefined ? ['-z'] : ['--use-compress-program', `gzip -${level}`];
}

/** One entry per line; entries starting with '-' get './' so no tar treats them as options. */
export function formatManifest(entries: readonly string[]): string {
  return `${entries.map((entry) => (entry.startsWith('-') ? `./${entry}` : entry)).join('\n')}\n`;
}

/**
 * Builds the commands that create the archive. With `toStdout`, tar writes the archive to stdout
 * and the commands do not name `archivePath`. The two-command zstd plan cannot do this.
 */
export function buildCreateCommands(
  plan: ArchivePlan & { manifestPath: string; toStdout?: boolean }
): ArchiveCommand[] {
  const separateZstd = usesSeparateZstd(plan);
  if (separateZstd && plan.toStdout) {
    throw new Error('The separate zstd command cannot write the archive to stdout');
  }
  const tarFile = separateZstd
    ? path.join(plan.tempDir, 'cache.tar')
    : plan.toStdout
      ? '-'
      : plan.archivePath;

  const args: string[] = [];
  if (plan.tar.flavor === 'gnu') {
    args.push('--posix');
  }
  args.push('-cf', slashes(tarFile), '-P', '-C', slashes(plan.workspace));
  if (plan.tar.flavor === 'gnu') {
    args.push('--verbatim-files-from');
  }
  args.push('-T', slashes(plan.manifestPath), ...platformFlags(plan));

  if (!separateZstd) {
    args.push(
      ...compressionFlags(
        plan.compression,
        zstdCompressProgram(plan.level, plan.windowLog),
        plan.level
      )
    );
    return [{ tool: plan.tar.path, args }];
  }
  return [
    { tool: plan.tar.path, args },
    {
      tool: 'zstd',
      args: [
        ...(plan.level === undefined ? [] : [`-${plan.level}`]),
        '-T0',
        `--long=${plan.windowLog ?? ZSTD_WINDOW_LOG}`,
        '--force',
        '-o',
        slashes(plan.archivePath),
        slashes(tarFile),
      ],
    },
  ];
}

export function buildExtractCommands(plan: ArchivePlan): ArchiveCommand[] {
  if (usesSeparateZstd(plan)) {
    const tarFile = path.join(plan.tempDir, 'cache.tar');
    return [
      {
        tool: 'zstd',
        args: ['-d', '--long=30', '--force', '-o', slashes(tarFile), slashes(plan.archivePath)],
      },
      {
        tool: plan.tar.path,
        args: ['-xf', slashes(tarFile), '-P', '-C', slashes(plan.workspace)],
      },
    ];
  }
  return [
    {
      tool: plan.tar.path,
      args: [
        '-xf',
        slashes(plan.archivePath),
        '-P',
        '-C',
        slashes(plan.workspace),
        ...platformFlags(plan),
        ...compressionFlags(plan.compression, ZSTD_DECOMPRESS),
      ],
    },
  ];
}

/** MSYS value for every archive command: native symlinks, or a failure when not possible. */
export const MSYS_NATIVE_SYMLINKS = 'winsymlinks:nativestrict';

/**
 * MSYS value for the one extract retry. The MSYS2 runtime copies the link target. It does not use
 * 'winsymlinks:native', because that value falls back to WSL symlinks, and Windows programs
 * cannot open those.
 */
export const MSYS_COPY_SYMLINKS = 'winsymlinks:deepcopy';

/**
 * Options for every tar and zstd command. Like actions/cache, sets MSYS so Git's MSYS tar on
 * Windows extracts symlinks as native links instead of copies; other platforms ignore it.
 */
export function archiveExecOptions(
  env: NodeJS.ProcessEnv = process.env,
  msys: string = MSYS_NATIVE_SYMLINKS
): ExecOptions {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      inherited[name] = value;
    }
  }
  return { env: { ...inherited, MSYS: msys } };
}
