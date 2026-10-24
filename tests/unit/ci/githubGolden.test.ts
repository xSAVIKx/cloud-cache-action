import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCreateCommands } from '../../../src/archive/commands';
import { getWorkspace } from '../../../src/archive/paths';
import { Defaults } from '../../../src/constants';
import { compileKeyTemplate } from '../../../src/core/keyTemplate';
import { runnerOs } from '../../../src/core/presets';
import { resolveRefCandidates } from '../../../src/core/refs';
import { computeCacheVersion } from '../../../src/core/version';

const PATHS = ['node_modules', '~/.npm'];

interface Scenario {
  name: string;
  env: Record<string, string>;
  platform: NodeJS.Platform;
  expected: {
    restore: string[];
    saveKey: string;
    version: string;
    workspace: string;
    runnerOs: string;
    tarArgs: string[];
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'github-golden-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function eventFile(name: string): string {
  const file = join(dir, `${name.replace(/\W+/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ repository: { default_branch: 'main' } }));
  return file;
}

function baseEnv(): Record<string, string> {
  return {
    GITHUB_REPOSITORY: 'octo/app',
    RUNNER_OS: 'Linux',
    GITHUB_WORKSPACE: '/w',
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'push to main',
    env: { ...baseEnv(), GITHUB_REF: 'refs/heads/main' },
    platform: 'linux',
    expected: {
      restore: ['refs/heads/main'],
      saveKey: 'octo/app/refs%2Fheads%2Fmain/deps-1/87b7cfd49c9b3221/cache.tar.zst',
      version: '87b7cfd49c9b3221',
      workspace: '/w',
      runnerOs: 'Linux',
      tarArgs: [
        '--posix',
        '-cf',
        '/t/cache.tar.zst',
        '-P',
        '-C',
        '/w',
        '--verbatim-files-from',
        '-T',
        '/t/manifest.txt',
        '--use-compress-program',
        'zstd -T0 --long=30',
      ],
    },
  },
  {
    name: 'pull request',
    env: { ...baseEnv(), GITHUB_REF: 'refs/pull/7/merge', GITHUB_BASE_REF: 'develop' },
    platform: 'linux',
    expected: {
      restore: ['refs/pull/7/merge', 'refs/heads/develop', 'refs/heads/main'],
      saveKey: 'octo/app/refs%2Fpull%2F7%2Fmerge/deps-1/87b7cfd49c9b3221/cache.tar.zst',
      version: '87b7cfd49c9b3221',
      workspace: '/w',
      runnerOs: 'Linux',
      tarArgs: [
        '--posix',
        '-cf',
        '/t/cache.tar.zst',
        '-P',
        '-C',
        '/w',
        '--verbatim-files-from',
        '-T',
        '/t/manifest.txt',
        '--use-compress-program',
        'zstd -T0 --long=30',
      ],
    },
  },
  {
    name: 'tag',
    env: { ...baseEnv(), GITHUB_REF: 'refs/tags/v1.2.3' },
    platform: 'linux',
    expected: {
      restore: ['refs/tags/v1.2.3', 'refs/heads/main'],
      saveKey: 'octo/app/refs%2Ftags%2Fv1.2.3/deps-1/87b7cfd49c9b3221/cache.tar.zst',
      version: '87b7cfd49c9b3221',
      workspace: '/w',
      runnerOs: 'Linux',
      tarArgs: [
        '--posix',
        '-cf',
        '/t/cache.tar.zst',
        '-P',
        '-C',
        '/w',
        '--verbatim-files-from',
        '-T',
        '/t/manifest.txt',
        '--use-compress-program',
        'zstd -T0 --long=30',
      ],
    },
  },
  {
    name: 'workflow_dispatch on a feature branch',
    env: { ...baseEnv(), GITHUB_REF: 'refs/heads/feat/x', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    platform: 'linux',
    expected: {
      restore: ['refs/heads/feat/x', 'refs/heads/main'],
      saveKey: 'octo/app/refs%2Fheads%2Ffeat%2Fx/deps-1/87b7cfd49c9b3221/cache.tar.zst',
      version: '87b7cfd49c9b3221',
      workspace: '/w',
      runnerOs: 'Linux',
      tarArgs: [
        '--posix',
        '-cf',
        '/t/cache.tar.zst',
        '-P',
        '-C',
        '/w',
        '--verbatim-files-from',
        '-T',
        '/t/manifest.txt',
        '--use-compress-program',
        'zstd -T0 --long=30',
      ],
    },
  },
  {
    name: 'Windows push to main',
    env: {
      ...baseEnv(),
      GITHUB_REF: 'refs/heads/main',
      RUNNER_OS: 'Windows',
      GITHUB_WORKSPACE: 'D:\\a\\app',
    },
    platform: 'win32',
    expected: {
      restore: ['refs/heads/main'],
      saveKey: 'octo/app/refs%2Fheads%2Fmain/deps-1/3238684e250efce3/cache.tar.zst',
      version: '3238684e250efce3',
      workspace: 'D:\\a\\app',
      runnerOs: 'Windows',
      tarArgs: [
        '--posix',
        '-cf',
        '/t/cache.tar.zst',
        '-P',
        '-C',
        'D:/a/app',
        '--verbatim-files-from',
        '-T',
        '/t/manifest.txt',
        '--force-local',
        '--use-compress-program',
        'zstd -T0 --long=30',
      ],
    },
  },
];

describe('GitHub-visible values', () => {
  it.each(SCENARIOS)('$name', ({ name, env: scenarioEnv, platform, expected }) => {
    const env: NodeJS.ProcessEnv = { ...scenarioEnv, GITHUB_EVENT_PATH: eventFile(name) };

    const refs = resolveRefCandidates(env);
    expect(refs.restore).toEqual(expected.restore);

    const version = computeCacheVersion(PATHS, 'zstd', false, platform);
    expect(version).toBe(expected.version);

    const template = compileKeyTemplate({
      pattern: Defaults.DefaultS3KeyPattern,
      repository: env.GITHUB_REPOSITORY ?? '',
      prefix: '',
      scopedToRepository: true,
      scopedToRef: true,
      version,
      archiveFilename: 'cache.tar.zst',
      env,
    });
    expect(template.objectKey(refs.current as string, 'deps-1')).toBe(expected.saveKey);

    expect(getWorkspace(env)).toBe(expected.workspace);
    expect(runnerOs(env, platform)).toBe(expected.runnerOs);

    const commands = buildCreateCommands({
      tar: { path: 'tar', flavor: 'gnu' },
      platform,
      compression: 'zstd',
      archivePath: '/t/cache.tar.zst',
      workspace: getWorkspace(env),
      tempDir: '/t',
      manifestPath: '/t/manifest.txt',
    });
    expect(commands).toEqual([{ tool: 'tar', args: expected.tarArgs }]);
  });
});
