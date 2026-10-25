import * as path from 'node:path';
import { hashFiles } from '@actions/glob';
import { UsageError } from './args';

const OPEN = '{hash:';

export interface HashExpansion {
  text: string;
  /** The body of each template that matched no file. */
  unmatched: string[];
}

/** Joins a relative glob to the workspace and keeps a leading "!". */
function toAbsoluteGlob(glob: string, workspace: string): string {
  const negated = glob.startsWith('!');
  const body = negated ? glob.slice(1) : glob;
  const full = path.isAbsolute(body) ? body : path.join(workspace, body);
  return negated ? `!${full}` : full;
}

const DEBUG_PREFIX = '::debug::';

/**
 * Runs the function with process.stdout.write intercepted. A "::debug::<text>" line goes to the
 * callback. Any other write passes through unchanged. The original write is always restored.
 * @actions/glob calls core.debug, which writes these lines to stdout.
 */
async function withDebugIntercepted<T>(
  onDebug: (text: string) => void,
  fn: () => Promise<T>
): Promise<T> {
  const original = process.stdout.write;
  const intercept = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (typeof chunk === 'string' && chunk.startsWith(DEBUG_PREFIX)) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith(DEBUG_PREFIX)) {
          onDebug(line.slice(DEBUG_PREFIX.length));
        }
      }
      const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
      callback?.();
      return true;
    }
    return (original as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  };
  process.stdout.write = intercept as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = original;
  }
}

/**
 * Replaces each {hash:<glob>[,<glob>...]} in the text with the hashFiles hash of the files. A
 * template that matches no file gives an empty string. "${hash:" is not a template.
 */
export async function expandHashTemplates(
  text: string,
  workspace: string,
  onDebug: (text: string) => void = () => undefined
): Promise<HashExpansion> {
  // hashFiles keeps only files that start with "<workspace>/", so the root must be absolute and
  // have no trailing separator.
  const root = path.resolve(workspace);
  const unmatched: string[] = [];
  let result = '';
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(OPEN, pos);
    if (start === -1) {
      break;
    }
    if (start > 0 && text[start - 1] === '$') {
      result += text.slice(pos, start + OPEN.length);
      pos = start + OPEN.length;
      continue;
    }
    const end = text.indexOf('}', start);
    if (end === -1) {
      throw new UsageError(
        `The template ${text.slice(start)} has no closing }. Use {hash:<glob>}.`
      );
    }
    const body = text.slice(start + OPEN.length, end);
    const globs = body
      .split(',')
      .map((glob) => glob.trim())
      .filter((glob) => glob !== '');
    const patterns = globs.map((glob) => toAbsoluteGlob(glob, root)).join('\n');
    const hash = globs.length
      ? await withDebugIntercepted(onDebug, () => hashFiles(patterns, root))
      : '';
    if (hash === '') {
      unmatched.push(body);
    }
    result += text.slice(pos, start) + hash;
    pos = end + 1;
  }
  return { text: result + text.slice(pos), unmatched };
}
