import { jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(refs.current).toBe(expected.restore[0]);
    expect(template.objectKey(expected.restore[0], 'deps-1')).toBe(expected.saveKey);

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

const INPUTS: Record<string, string> = {
  key: 'deps-1',
  path: 'node_modules\n~/.npm',
  bucket: 'golden-bucket',
  region: 'us-east-1',
  'access-key-id': 'golden',
  'secret-access-key': 'golden',
};
jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => INPUTS[name] ?? '',
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
}));
const { buildCreateCommands } = await import('../../../src/archive/commands');
const { getWorkspace } = await import('../../../src/archive/paths');
const { Defaults } = await import('../../../src/constants');
const { compileKeyTemplate } = await import('../../../src/core/keyTemplate');
const { runnerOs } = await import('../../../src/core/presets');
const { resolveRefCandidates } = await import('../../../src/core/refs');
const { computeCacheVersion } = await import('../../../src/core/version');
const { readCacheConfig } = await import('../../../src/core/config');
const { buildS3Tier } = await import('../../../src/core/s3Tier');

describe('S3 tier wiring reads the process environment', () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, saved);
  });

  // buildS3Tier hashes the version with process.platform, not RUNNER_OS, so the version in the
  // save key depends on the test host: 3238684e250efce3 on win32, 87b7cfd49c9b3221 elsewhere.
  const isWindowsHost = process.platform === 'win32';
  const WIRED = [
    {
      ...SCENARIOS[0],
      saveKey: isWindowsHost
        ? 'octo/app/refs%2Fheads%2Fmain/deps-1/3238684e250efce3/cache.tar.zst'
        : 'octo/app/refs%2Fheads%2Fmain/deps-1/87b7cfd49c9b3221/cache.tar.zst',
    },
    {
      ...SCENARIOS[1],
      saveKey: isWindowsHost
        ? 'octo/app/refs%2Fpull%2F7%2Fmerge/deps-1/3238684e250efce3/cache.tar.zst'
        : 'octo/app/refs%2Fpull%2F7%2Fmerge/deps-1/87b7cfd49c9b3221/cache.tar.zst',
    },
    {
      ...SCENARIOS[4],
      saveKey: isWindowsHost
        ? 'octo/app/refs%2Fheads%2Fmain/deps-1/3238684e250efce3/cache.tar.zst'
        : 'octo/app/refs%2Fheads%2Fmain/deps-1/87b7cfd49c9b3221/cache.tar.zst',
    },
  ];

  it.each(WIRED)('$name', async ({ name, env, expected, saveKey }) => {
    for (const variable of ['GITHUB_REF', 'GITHUB_BASE_REF', 'GITHUB_EVENT_NAME']) {
      delete process.env[variable];
    }
    Object.assign(process.env, env, {
      GITHUB_EVENT_PATH: eventFile(name),
      HOME: '/home/runner',
    });

    const tier = await buildS3Tier(readCacheConfig(), undefined, { compression: 'zstd' });

    expect(tier.restoreRefs).toEqual(expected.restore);
    expect(tier.saveRef).toBe(expected.restore[0]);
    expect(tier.workspace).toBe(expected.workspace);
    expect(tier.template.objectKey(tier.saveRef, 'deps-1')).toBe(saveKey);
  });
});
