import { getWorkspace } from '../ci/env';
import { log } from '../ci/log';
import * as glob from '@actions/glob';
import * as os from 'node:os';
import * as path from 'node:path';

export { getWorkspace } from '../ci/env';

export interface ResolvedCachePaths {
  /** Tar manifest entries: relative to the workspace, `/`-separated, sorted, no overlaps. */
  entries: string[];
  /** Matches that cannot be written to a tar manifest. */
  skipped: string[];
}

/**
 * Mirrors `os.homedir()`'s own documented resolution (`$HOME`/`%USERPROFILE%` first, native
 * lookup otherwise) but reads the environment variable directly rather than delegating to the
 * native binding. The native binding reads the process's real environment, which under Jest's
 * `node` test environment is a snapshot disconnected from the `process.env` object tests mutate;
 * reading the variable in plain JS keeps it overridable in tests while matching real behaviour.
 */
function defaultHomedir(platform: NodeJS.Platform): string {
  const fromEnv = platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return fromEnv || os.homedir();
}

/** Escapes glob metacharacters in a literal path so it can prefix a pattern. */
export function globEscape(value: string, platform: NodeJS.Platform = process.platform): string {
  const escaped = platform === 'win32' ? value : value.replace(/\\/g, '\\\\');
  return escaped.replace(/\[/g, '[[]').replace(/\?/g, '[?]').replace(/\*/g, '[*]');
}

/**
 * Makes one `path` line absolute and free of `.`/`..` segments, which @actions/glob rejects.
 * `~` expands to the home directory; relative patterns are anchored at the workspace.
 */
export function preparePattern(
  raw: string,
  workspace: string,
  platform: NodeJS.Platform = process.platform,
  homedir: string = defaultHomedir(platform)
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let pattern = raw.trim();
  const negate = pattern.startsWith('!');
  if (negate) {
    pattern = pattern.slice(1).trim();
  }

  if (pattern === '~' || pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    pattern = p.join(globEscape(homedir, platform), pattern.slice(1));
  } else if (p.isAbsolute(pattern)) {
    pattern = p.normalize(pattern);
  } else {
    pattern = p.join(globEscape(workspace, platform), pattern);
  }
  return negate ? `!${pattern}` : pattern;
}

/** True when an ancestor of `entry` is itself an entry, so tar already archives it. */
function isCovered(entry: string, entries: ReadonlySet<string>): boolean {
  const insideWorkspace = entry !== '..' && !entry.startsWith('../') && !path.isAbsolute(entry);
  if (entry !== '.' && insideWorkspace && entries.has('.')) {
    return true;
  }
  const segments = entry.split('/');
  for (let length = 1; length < segments.length; length++) {
    if (entries.has(segments.slice(0, length).join('/'))) {
      return true;
    }
  }
  return false;
}

/** Expands `path` patterns like actions/cache: globs, `~`, and ordered `!` exclusions. */
export async function resolveCachePaths(
  patterns: readonly string[],
  workspace: string = getWorkspace()
): Promise<ResolvedCachePaths> {
  const prepared = patterns
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => preparePattern(line, workspace));
  if (prepared.length === 0) {
    return { entries: [], skipped: [] };
  }

  const globber = await glob.create(prepared.join('\n'), {
    implicitDescendants: false,
    followSymbolicLinks: false,
  });

  const found = new Set<string>();
  const skipped: string[] = [];
  for await (const match of globber.globGenerator()) {
    const relative = path.relative(workspace, match).split(path.sep).join('/');
    const entry = relative === '' ? '.' : relative;
    if (/[\r\n]/.test(entry)) {
      skipped.push(entry);
      log.warning(
        `Skipping ${JSON.stringify(entry)}: file names containing line breaks cannot be cached.`
      );
      continue;
    }
    found.add(entry);
  }

  const entries = [...found].filter((entry) => !isCovered(entry, found)).sort();
  return { entries, skipped };
}
