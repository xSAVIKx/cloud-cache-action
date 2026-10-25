import { hashFiles } from '@actions/glob';
import * as path from 'node:path';
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

/**
 * Replaces each {hash:<glob>[,<glob>...]} in the text with the hashFiles hash of the files. A
 * template that matches no file gives an empty string. "${hash:" is not a template.
 */
export async function expandHashTemplates(text: string, workspace: string): Promise<HashExpansion> {
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
    const hash = globs.length
      ? await hashFiles(globs.map((glob) => toAbsoluteGlob(glob, workspace)).join('\n'), workspace)
      : '';
    if (hash === '') {
      unmatched.push(body);
    }
    result += text.slice(pos, start) + hash;
    pos = end + 1;
  }
  return { text: result + text.slice(pos), unmatched };
}
