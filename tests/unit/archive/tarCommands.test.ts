import {
  buildCreateCommands,
  buildExtractCommands,
  findTar,
  formatManifest,
  type ArchiveCommand,
  type TarTool,
  type ToolLookup,
  zstdWindowLog,
} from '../../../src/archive/tar';

const gnu: TarTool = { path: '/usr/bin/tar', flavor: 'gnu' };
const gtar: TarTool = { path: '/opt/homebrew/bin/gtar', flavor: 'gnu' };
const bsdMac: TarTool = { path: '/usr/bin/tar', flavor: 'bsd' };
const gitTar: TarTool = { path: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe', flavor: 'gnu' };
const systemTar: TarTool = { path: 'C:\\Windows\\System32\\tar.exe', flavor: 'bsd' };

const unix = {
  workspace: '/home/runner/work/app/app',
  tempDir: '/tmp/t',
  manifestPath: '/tmp/t/manifest.txt',
};
const win = {
  workspace: 'D:\\a\\app\\app',
  tempDir: 'D:\\a\\_temp\\t',
  manifestPath: 'D:\\a\\_temp\\t\\manifest.txt',
};

describe('buildCreateCommands', () => {
  it.each<[string, Parameters<typeof buildCreateCommands>[0], ArchiveCommand[]]>([
    [
      'GNU tar with zstd on Linux',
      {
        ...unix,
        tar: gnu,
        platform: 'linux',
        compression: 'zstd',
        archivePath: '/tmp/t/cache.tar.zst',
      },
      [
        {
          tool: '/usr/bin/tar',
          args: [
            '--posix',
            '-cf',
            '/tmp/t/cache.tar.zst',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '--verbatim-files-from',
            '-T',
            '/tmp/t/manifest.txt',
            '--use-compress-program',
            'zstd -T0 --long=30',
          ],
        },
      ],
    ],
    [
      'GNU tar with gzip on Linux',
      {
        ...unix,
        tar: gnu,
        platform: 'linux',
        compression: 'gzip',
        archivePath: '/tmp/t/cache.tar.gz',
      },
      [
        {
          tool: '/usr/bin/tar',
          args: [
            '--posix',
            '-cf',
            '/tmp/t/cache.tar.gz',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '--verbatim-files-from',
            '-T',
            '/tmp/t/manifest.txt',
            '-z',
          ],
        },
      ],
    ],
    [
      'gtar on macOS',
      {
        ...unix,
        tar: gtar,
        platform: 'darwin',
        compression: 'zstd',
        archivePath: '/tmp/t/cache.tar.zst',
      },
      [
        {
          tool: '/opt/homebrew/bin/gtar',
          args: [
            '--posix',
            '-cf',
            '/tmp/t/cache.tar.zst',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '--verbatim-files-from',
            '-T',
            '/tmp/t/manifest.txt',
            '--delay-directory-restore',
            '--use-compress-program',
            'zstd -T0 --long=30',
          ],
        },
      ],
    ],
    [
      'BSD tar on macOS',
      {
        ...unix,
        tar: bsdMac,
        platform: 'darwin',
        compression: 'zstd',
        archivePath: '/tmp/t/cache.tar.zst',
      },
      [
        {
          tool: '/usr/bin/tar',
          args: [
            '-cf',
            '/tmp/t/cache.tar.zst',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '-T',
            '/tmp/t/manifest.txt',
            '--use-compress-program',
            'zstd -T0 --long=30',
          ],
        },
      ],
    ],
    [
      'Git GNU tar on Windows',
      {
        ...win,
        tar: gitTar,
        platform: 'win32',
        compression: 'zstd',
        archivePath: 'D:\\a\\_temp\\t\\cache.tar.zst',
      },
      [
        {
          tool: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe',
          args: [
            '--posix',
            '-cf',
            'D:/a/_temp/t/cache.tar.zst',
            '-P',
            '-C',
            'D:/a/app/app',
            '--verbatim-files-from',
            '-T',
            'D:/a/_temp/t/manifest.txt',
            '--force-local',
            '--use-compress-program',
            'zstd -T0 --long=30',
          ],
        },
      ],
    ],
    [
      'System32 BSD tar with zstd on Windows (two steps)',
      {
        ...win,
        tar: systemTar,
        platform: 'win32',
        compression: 'zstd',
        archivePath: 'D:\\a\\_temp\\t\\cache.tar.zst',
      },
      [
        {
          tool: 'C:\\Windows\\System32\\tar.exe',
          args: [
            '-cf',
            'D:/a/_temp/t/cache.tar',
            '-P',
            '-C',
            'D:/a/app/app',
            '-T',
            'D:/a/_temp/t/manifest.txt',
          ],
        },
        {
          tool: 'zstd',
          args: [
            '-T0',
            '--long=30',
            '--force',
            '-o',
            'D:/a/_temp/t/cache.tar.zst',
            'D:/a/_temp/t/cache.tar',
          ],
        },
      ],
    ],
    [
      'System32 BSD tar with gzip on Windows',
      {
        ...win,
        tar: systemTar,
        platform: 'win32',
        compression: 'gzip',
        archivePath: 'D:\\a\\_temp\\t\\cache.tar.gz',
      },
      [
        {
          tool: 'C:\\Windows\\System32\\tar.exe',
          args: [
            '-cf',
            'D:/a/_temp/t/cache.tar.gz',
            '-P',
            '-C',
            'D:/a/app/app',
            '-T',
            'D:/a/_temp/t/manifest.txt',
            '-z',
          ],
        },
      ],
    ],
  ])('%s', (_label, plan, expected) => {
    expect(buildCreateCommands(plan)).toEqual(expected);
  });
});

describe('buildCreateCommands compression level', () => {
  const zstdPlan = {
    tar: gnu,
    platform: 'linux' as NodeJS.Platform,
    compression: 'zstd' as const,
    archivePath: '/tmp/cache.tar.zst',
    ...unix,
  };
  const gzipPlan = { ...zstdPlan, compression: 'gzip' as const, archivePath: '/tmp/cache.tar.gz' };

  it('passes the level to zstd when one is set', () => {
    expect(buildCreateCommands({ ...zstdPlan, level: 1 })[0].args).toContain(
      'zstd -1 -T0 --long=30'
    );
  });

  it('keeps the default zstd command when no level is set', () => {
    expect(buildCreateCommands(zstdPlan)[0].args).toContain('zstd -T0 --long=30');
  });

  it('uses a compress program for gzip only when a level is set', () => {
    expect(buildCreateCommands(gzipPlan)[0].args).toContain('-z');
    expect(buildCreateCommands({ ...gzipPlan, level: 1 })[0].args).toContain('gzip -1');
  });

  it('passes the level to the Windows two-step zstd command', () => {
    const commands = buildCreateCommands({
      tar: systemTar,
      platform: 'win32',
      compression: 'zstd',
      archivePath: 'D:\\a\\_temp\\cache.tar.zst',
      ...win,
      level: 5,
    });
    expect(commands[1].args.slice(0, 3)).toEqual(['-5', '-T0', '--long=30']);
  });
});

describe('the zstd window', () => {
  const GiB = 1024 * 1024 * 1024;
  const zstdPlan = {
    tar: gnu,
    platform: 'linux' as NodeJS.Platform,
    compression: 'zstd' as const,
    archivePath: '/tmp/cache.tar.zst',
    ...unix,
  };

  it.each([
    [0, 27],
    [1 * GiB, 27],
    [1.5 * GiB - 1, 27],
    [1.5 * GiB, 30],
    [16 * GiB, 30],
  ])('uses window log %s for %s bytes of usable memory', (memory, windowLog) => {
    expect(zstdWindowLog(memory)).toBe(windowLog);
  });

  it('keeps the 1 GiB window when no window is set', () => {
    expect(buildCreateCommands(zstdPlan)[0].args).toContain('zstd -T0 --long=30');
  });

  it('passes the window to the zstd compress program, with and without a level', () => {
    expect(buildCreateCommands({ ...zstdPlan, windowLog: 27 })[0].args).toContain(
      'zstd -T0 --long=27'
    );
    expect(buildCreateCommands({ ...zstdPlan, windowLog: 27, level: 1 })[0].args).toContain(
      'zstd -1 -T0 --long=27'
    );
  });

  it('passes the window to the Windows two-step zstd command', () => {
    const commands = buildCreateCommands({
      tar: systemTar,
      platform: 'win32',
      compression: 'zstd',
      archivePath: 'D:\\a\\_temp\\cache.tar.zst',
      ...win,
      windowLog: 27,
    });
    expect(commands[1].args.slice(0, 2)).toEqual(['-T0', '--long=27']);
  });

  it('always restores with --long=30, which decodes an archive with either window', () => {
    expect(buildExtractCommands(zstdPlan)[0].args).toContain('zstd -d --long=30');
    const windows = buildExtractCommands({
      tar: systemTar,
      platform: 'win32',
      compression: 'zstd',
      archivePath: 'D:\\a\\_temp\\cache.tar.zst',
      ...win,
    });
    expect(windows[0].args.slice(0, 2)).toEqual(['-d', '--long=30']);
  });
});

describe('buildCreateCommands to stdout', () => {
  const plan = {
    ...unix,
    tar: gnu,
    platform: 'linux' as NodeJS.Platform,
    compression: 'zstd' as const,
    archivePath: '/tmp/t/cache.tar.zst',
  };

  it('writes the archive to stdout and does not name the output path', () => {
    const commands = buildCreateCommands({ ...plan, toStdout: true });
    expect(commands).toHaveLength(1);
    expect(commands[0].args.slice(0, 3)).toEqual(['--posix', '-cf', '-']);
    expect(commands[0].args).not.toContain('/tmp/t/cache.tar.zst');
  });

  it('keeps every other argument the same as the command that writes the file', () => {
    const toFile = buildCreateCommands(plan)[0].args;
    const toStdout = buildCreateCommands({ ...plan, toStdout: true })[0].args;
    expect(toStdout).toEqual(toFile.map((arg) => (arg === plan.archivePath ? '-' : arg)));
  });

  it('refuses stdout for the Windows two-step zstd commands', () => {
    expect(() =>
      buildCreateCommands({
        ...win,
        tar: systemTar,
        platform: 'win32',
        compression: 'zstd',
        archivePath: 'D:\\a\\_temp\\cache.tar.zst',
        toStdout: true,
      })
    ).toThrow();
  });
});

describe('buildExtractCommands', () => {
  it.each<[string, Parameters<typeof buildExtractCommands>[0], ArchiveCommand[]]>([
    [
      'GNU tar with zstd on Linux',
      {
        ...unix,
        tar: gnu,
        platform: 'linux',
        compression: 'zstd',
        archivePath: '/tmp/t/cache.tar.zst',
      },
      [
        {
          tool: '/usr/bin/tar',
          args: [
            '-xf',
            '/tmp/t/cache.tar.zst',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '--use-compress-program',
            'zstd -d --long=30',
          ],
        },
      ],
    ],
    [
      'gtar on macOS',
      {
        ...unix,
        tar: gtar,
        platform: 'darwin',
        compression: 'zstd',
        archivePath: '/tmp/t/cache.tar.zst',
      },
      [
        {
          tool: '/opt/homebrew/bin/gtar',
          args: [
            '-xf',
            '/tmp/t/cache.tar.zst',
            '-P',
            '-C',
            '/home/runner/work/app/app',
            '--delay-directory-restore',
            '--use-compress-program',
            'zstd -d --long=30',
          ],
        },
      ],
    ],
    [
      'Git GNU tar with gzip on Windows',
      {
        ...win,
        tar: gitTar,
        platform: 'win32',
        compression: 'gzip',
        archivePath: 'D:\\a\\_temp\\t\\cache.tar.gz',
      },
      [
        {
          tool: 'C:\\Program Files\\Git\\usr\\bin\\tar.exe',
          args: [
            '-xf',
            'D:/a/_temp/t/cache.tar.gz',
            '-P',
            '-C',
            'D:/a/app/app',
            '--force-local',
            '-z',
          ],
        },
      ],
    ],
    [
      'System32 BSD tar with zstd on Windows (two steps)',
      {
        ...win,
        tar: systemTar,
        platform: 'win32',
        compression: 'zstd',
        archivePath: 'D:\\a\\_temp\\t\\cache.tar.zst',
      },
      [
        {
          tool: 'zstd',
          args: [
            '-d',
            '--long=30',
            '--force',
            '-o',
            'D:/a/_temp/t/cache.tar',
            'D:/a/_temp/t/cache.tar.zst',
          ],
        },
        {
          tool: 'C:\\Windows\\System32\\tar.exe',
          args: ['-xf', 'D:/a/_temp/t/cache.tar', '-P', '-C', 'D:/a/app/app'],
        },
      ],
    ],
  ])('%s', (_label, plan, expected) => {
    expect(buildExtractCommands(plan)).toEqual(expected);
  });
});

describe('formatManifest', () => {
  it('prefixes entries that start with a dash so tar never reads them as options', () => {
    expect(formatManifest(['a', '-C', '--checkpoint-action=exec=x', 'dir/-inner', '../out'])).toBe(
      'a\n./-C\n./--checkpoint-action=exec=x\ndir/-inner\n../out\n'
    );
  });
});

describe('findTar', () => {
  const lookup = (
    platform: NodeJS.Platform,
    onPath: Record<string, string>,
    files: string[] = []
  ): ToolLookup => ({
    platform,
    env: { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' },
    which: async (tool) => onPath[tool] ?? '',
    exists: (file) => files.includes(file),
  });

  it('uses GNU tar on Linux', async () => {
    await expect(findTar(lookup('linux', { tar: '/usr/bin/tar' }))).resolves.toEqual(gnu);
  });

  it('prefers gtar on macOS and falls back to BSD tar', async () => {
    await expect(
      findTar(lookup('darwin', { gtar: '/opt/homebrew/bin/gtar', tar: '/usr/bin/tar' }))
    ).resolves.toEqual(gtar);
    await expect(findTar(lookup('darwin', { tar: '/usr/bin/tar' }))).resolves.toEqual(bsdMac);
  });

  it("prefers Git's GNU tar on Windows and falls back to System32 tar", async () => {
    await expect(findTar(lookup('win32', {}, [gitTar.path, systemTar.path]))).resolves.toEqual(
      gitTar
    );
    await expect(findTar(lookup('win32', {}, [systemTar.path]))).resolves.toEqual(systemTar);
  });

  it('fails clearly when no tar exists', async () => {
    await expect(findTar(lookup('linux', {}))).rejects.toThrow('tar was not found');
    await expect(findTar(lookup('win32', {}))).rejects.toThrow('tar was not found');
  });
});
