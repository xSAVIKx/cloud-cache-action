/**
 * Cache presets: one input that gives the `path`, `key` and `restore-keys` of a package
 * manager, like the `cache:` input of actions/setup-node. Each preset caches the download
 * cache of the tool, not node_modules or a build output. The paths are static documented
 * defaults; the action never runs the package manager to find them. docs/guide/presets.md
 * cites the source of every value.
 */

import { getHost } from '../ci/host';
import type { RunnerOs } from '../ci/env';
import { log } from '../ci/log';
import * as glob from '@actions/glob';
import { preparePattern } from '../archive/paths';
import { Inputs } from '../constants';
import type { CacheConfig } from './config';

export { type RunnerOs, runnerOs } from '../ci/env';

export const PRESET_NAMES = [
  'npm',
  'yarn',
  'pnpm',
  'bun',
  'pip',
  'poetry',
  'uv',
  'gradle',
  'maven',
  'cargo',
  'go',
] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export interface PresetDefinition {
  /** The default `path` lines per operating system. */
  paths: Record<RunnerOs, readonly string[]>;
  /** Workspace-relative globs whose files `hashFiles` hashes into the key. */
  lockfiles: readonly string[];
}

/** The same `~`-relative paths on all three systems, with `\` on Windows. */
function everywhere(...paths: string[]): Record<RunnerOs, readonly string[]> {
  return { Linux: paths, macOS: paths, Windows: paths.map((p) => p.replace(/\//g, '\\')) };
}

/** A lockfile that a package can ship must not change the key after an install. */
const NODE_MODULES = '!**/node_modules/**';

export const PRESETS: Record<PresetName, PresetDefinition> = {
  // npm docs (config "cache"): Posix ~/.npm, Windows %LocalAppData%\npm-cache.
  npm: {
    paths: {
      Linux: ['~/.npm'],
      macOS: ['~/.npm'],
      Windows: ['~\\AppData\\Local\\npm-cache'],
    },
    lockfiles: ['**/package-lock.json', '**/npm-shrinkwrap.json', NODE_MODULES],
  },
  // The Yarn 1 cache folder per OS (getCacheDir in yarn src/util/user-dirs.js), the Yarn 2+
  // global cache (`${globalFolder}/cache` when enableGlobalCache is true, the default; globalFolder
  // from getDefaultGlobalFolder in berry folderUtils.ts) and the Yarn 2+ project cache
  // (cacheFolder ./.yarn/cache).
  yarn: {
    paths: {
      Linux: ['~/.cache/yarn', '~/.yarn/berry/cache', '.yarn/cache'],
      macOS: ['~/Library/Caches/Yarn', '~/.yarn/berry/cache', '.yarn/cache'],
      Windows: [
        '~\\AppData\\Local\\Yarn\\Cache',
        '~\\AppData\\Local\\Yarn\\Berry\\cache',
        '.yarn\\cache',
      ],
    },
    lockfiles: ['**/yarn.lock', NODE_MODULES],
  },
  // pnpm docs (settings/store, storeDir) when PNPM_HOME and XDG_DATA_HOME are not set.
  pnpm: {
    paths: {
      Linux: ['~/.local/share/pnpm/store'],
      macOS: ['~/Library/pnpm/store'],
      Windows: ['~\\AppData\\Local\\pnpm\\store'],
    },
    lockfiles: ['**/pnpm-lock.yaml', NODE_MODULES],
  },
  // Bun docs (install/cache) and the actions/cache examples.
  bun: {
    paths: everywhere('~/.bun/install/cache'),
    lockfiles: ['**/bun.lock', '**/bun.lockb', NODE_MODULES],
  },
  // actions/cache examples (Python - pip), per OS.
  pip: {
    paths: {
      Linux: ['~/.cache/pip'],
      macOS: ['~/Library/Caches/pip'],
      Windows: ['~\\AppData\\Local\\pip\\Cache'],
    },
    lockfiles: ['**/requirements.txt'],
  },
  // Poetry docs (configuration, cache-dir) give the directory. Poetry's config.py puts the
  // package caches in its `cache` and `artifacts` children. The preset lists them and leaves out
  // `virtualenvs`, which holds environments for one Python version. A `!` line cannot leave out a
  // child of a matched directory, because tar archives the whole directory.
  poetry: {
    paths: {
      Linux: ['~/.cache/pypoetry/cache', '~/.cache/pypoetry/artifacts'],
      macOS: ['~/Library/Caches/pypoetry/cache', '~/Library/Caches/pypoetry/artifacts'],
      Windows: [
        '~\\AppData\\Local\\pypoetry\\Cache\\cache',
        '~\\AppData\\Local\\pypoetry\\Cache\\artifacts',
      ],
    },
    lockfiles: ['**/poetry.lock'],
  },
  // uv docs (reference/storage): $HOME/.cache/uv on Unix, %LOCALAPPDATA%\uv\cache on Windows.
  // The globs are the cache-dependency-glob default of astral-sh/setup-uv.
  uv: {
    paths: {
      Linux: ['~/.cache/uv'],
      macOS: ['~/.cache/uv'],
      Windows: ['~\\AppData\\Local\\uv\\cache'],
    },
    lockfiles: [
      '**/*requirements*.txt',
      '**/*requirements*.in',
      '**/*constraints*.txt',
      '**/*constraints*.in',
      '**/pyproject.toml',
      '**/uv.lock',
      '**/*.py.lock',
    ],
  },
  // Paths: actions/cache examples (Java - Gradle). Globs: actions/setup-java.
  gradle: {
    paths: everywhere('~/.gradle/caches', '~/.gradle/wrapper'),
    lockfiles: [
      '**/*.gradle*',
      '**/gradle.properties',
      '**/gradle-wrapper.properties',
      'buildSrc/**/Versions.kt',
      'buildSrc/**/Dependencies.kt',
      'gradle/*.versions.toml',
      '**/versions.properties',
    ],
  },
  // Path: actions/cache examples (Java - Maven). Globs: actions/setup-java.
  maven: {
    paths: everywhere('~/.m2/repository'),
    lockfiles: ['**/pom.xml', '**/.mvn/wrapper/maven-wrapper.properties', '**/.mvn/extensions.xml'],
  },
  // actions/cache examples (Rust - Cargo) without ~/.cargo/bin and target: those hold build
  // output, not downloads (docs/guide/presets.md tells why).
  cargo: {
    paths: everywhere('~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db'),
    lockfiles: ['**/Cargo.lock'],
  },
  // actions/cache examples (Go - Modules), per OS.
  go: {
    paths: {
      Linux: ['~/go/pkg/mod', '~/.cache/go-build'],
      macOS: ['~/go/pkg/mod', '~/Library/Caches/go-build'],
      Windows: ['~\\go\\pkg\\mod', '~\\AppData\\Local\\go-build'],
    },
    lockfiles: ['**/go.sum'],
  },
};

/** Reads the `preset` input; an unknown value fails the step, because a typo caches nothing. */
export function readPreset(raw: string = getHost().input(Inputs.Preset)): PresetName | undefined {
  const value = raw.trim();
  if (value === '') {
    return undefined;
  }
  if (!(PRESET_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `Input "${Inputs.Preset}" must be one of ${PRESET_NAMES.join(', ')}; got "${value}".`
    );
  }
  return value as PresetName;
}

export interface PresetOptions {
  os?: RunnerOs;
  workspace?: string;
  /** The `hashFiles` function; tests replace it. */
  hash?: (patterns: string, workspace: string) => Promise<string>;
}

/**
 * Fills the `path`, `key` and `restore-keys` that the user did not set from the preset. Each
 * explicit input wins for that input only. The preset restore-keys apply only when the key is
 * the preset key too: a prefix of the preset key does not match a key that the user chose.
 * A config whose key is already set (the post step reads it from state) is not hashed again.
 */
export async function applyPreset(
  config: CacheConfig,
  name: PresetName | undefined,
  options: PresetOptions = {}
): Promise<CacheConfig> {
  if (!name) {
    return config;
  }
  const preset = PRESETS[name];
  const os = options.os ?? getHost().context().runnerOs;
  const workspace = options.workspace ?? getHost().context().workspace;
  const hash = options.hash ?? ((patterns, ws) => glob.hashFiles(patterns, ws));

  const paths = config.paths.length > 0 ? config.paths : [...preset.paths[os]];
  let primaryKey = config.primaryKey;
  let restoreKeys = config.restoreKeys;
  if (!primaryKey) {
    const platform: NodeJS.Platform = os === 'Windows' ? 'win32' : 'linux';
    const patterns = preset.lockfiles.map((line) => preparePattern(line, workspace, platform));
    const digest = await hash(patterns.join('\n'), workspace);
    if (!digest) {
      const looked = preset.lockfiles.filter((line) => !line.startsWith('!')).join(', ');
      throw new Error(
        `Preset "${name}" found no lockfile to hash in ${workspace}. It looked for: ${looked}. Add a lockfile, or set the key input.`
      );
    }
    primaryKey = `${os}-${name}-${digest}`;
    if (restoreKeys.length === 0) {
      restoreKeys = [`${os}-${name}-`];
    }
  }

  log.info(`Preset ${name}: path ${paths.join(', ')}; key ${primaryKey}`);
  return { ...config, preset: name, paths, primaryKey, restoreKeys };
}
