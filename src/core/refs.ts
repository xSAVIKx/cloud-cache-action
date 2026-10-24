import { readFileSync } from 'node:fs';

export interface RefCandidates {
  /** The ref saves are written under; undefined when GITHUB_REF is not set. */
  current?: string;
  /** Refs a restore searches, in order: current, pull request base, default branch. */
  restore: string[];
}

function readDefaultBranch(
  eventPath: string | undefined,
  readFile: (file: string) => string
): string | undefined {
  if (!eventPath) {
    return undefined;
  }
  try {
    const payload = JSON.parse(readFile(eventPath)) as {
      repository?: { default_branch?: unknown };
    };
    const branch = payload.repository?.default_branch;
    return typeof branch === 'string' && branch ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface RefCandidateInput {
  /** The full ref of this run, for example refs/heads/main. */
  current?: string;
  /** The pull request base branch name, without a refs/heads/ prefix. */
  baseRef?: string;
  /** The repository default branch name, without a refs/heads/ prefix. */
  defaultBranch?: string;
}

/** Mirrors actions/cache: a run may restore from its own ref, its PR base, and the default branch. */
export function refCandidates(input: RefCandidateInput): RefCandidates {
  const current = input.current?.trim() || undefined;
  if (!current) {
    return { current: undefined, restore: [] };
  }

  const candidates = [current];
  const baseRef = input.baseRef?.trim();
  if (baseRef) {
    candidates.push(`refs/heads/${baseRef}`);
  }
  if (input.defaultBranch) {
    candidates.push(`refs/heads/${input.defaultBranch}`);
  }
  return { current, restore: [...new Set(candidates)] };
}

/** Reads the GitHub environment and applies the ref candidate rules. */
export function resolveRefCandidates(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')
): RefCandidates {
  return refCandidates({
    current: env.GITHUB_REF,
    baseRef: env.GITHUB_BASE_REF,
    defaultBranch: readDefaultBranch(env.GITHUB_EVENT_PATH, readFile),
  });
}
