/**
 * Turns `s3-key-pattern` into object keys, listing prefixes and key extraction.
 *
 * The pattern is split around its single `${key}`. The text before it (the base) and after it
 * (the suffix) is resolved without the key, so a key is inserted verbatim and can be read back
 * by slicing the base and suffix off an object key, even when the key contains `/` or `$`.
 */

const SPECIAL_VARIABLES = new Set([
  'GITHUB_REPOSITORY',
  'repository',
  'prefix',
  'ref',
  'key',
  'version',
  'archive_filename',
]);
const KEY_PLACEHOLDER = '${key}';
const RESOLVED_PLACEHOLDERS = /\$\{(GITHUB_REPOSITORY|prefix|ref|version|archive_filename)\}/g;
/** Wraps a wildcard's name in scope text; it never occurs in a pattern or an object key. */
const MARK = '\u0000';
/** Every encoded full Git ref (refs/...) starts with this, and a repository name cannot. */
const ENCODED_REF_START = 'refs%2F';
const ARCHIVE_FILENAME_PATTERN = '(?:cache\\.tar\\.zst|cache\\.tar\\.gz)';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface KeyTemplateOptions {
  pattern: string;
  repository: string;
  prefix: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  version: string;
  archiveFilename: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Why a prune scope cannot be matched safely:
 * - `repository-shares-segment`: every `${GITHUB_REPOSITORY}` shares a path segment with
 *   `${key}`, `${version}` or a preceding `${ref}`, so another repository's keys could match.
 * - `ref-shares-segment`: every `${ref}` shares a path segment with `${key}`, `${version}` or
 *   another `${ref}`, so another ref's keys could match.
 * - `no-ref`: a single ref was requested, but the pattern has no `${ref}`.
 * - `no-archive-filename`: the pattern has no `${archive_filename}`, so cache archives cannot be
 *   told apart from other objects.
 */
export type ScopeProblem =
  | 'no-archive-filename'
  | 'repository-shares-segment'
  | 'ref-shares-segment'
  | 'no-ref';

export interface KeyTemplate {
  objectKey(ref: string, key: string): string;
  searchPrefix(ref: string, keyPrefix: string): string;
  extractKey(ref: string, objectKey: string): string | undefined;
  /**
   * The `${version}` hash an object key carries, or undefined when the key does not fit the
   * pattern for `ref` at all, or when the pattern has no `${version}`. Used by the explain
   * report to say why a candidate was rejected.
   */
  extractVersion(ref: string, objectKey: string): string | undefined;
  /**
   * The longest fixed listing prefix that contains every object this template can produce for
   * `ref`, or for every ref when `ref` is undefined, whatever its key, version and archive
   * filename. Used to enumerate a scope for pruning.
   */
  scopePrefix(ref?: string): string;
  /**
   * Matches, anchored at both ends, exactly the object keys this template can produce for `ref`
   * (every ref when undefined), with any key, any version and either archive filename.
   */
  scopeMatcher(ref?: string): RegExp;
  /**
   * Why `scopeMatcher(ref)` cannot tell this repository's (or this ref's) objects apart from
   * another repository's (or ref's) objects written with the same pattern, or undefined when it
   * can.
   */
  scopeProblem(ref?: string): ScopeProblem | undefined;
  readonly warnings: readonly string[];
  /** The `s3-key-pattern` input as it was written, before any resolution. */
  readonly pattern: string;
  /**
   * The pattern after the scoping options removed placeholders and `${GITHUB_REPOSITORY}` and
   * `${prefix}` were substituted, with `${ref}`, `${key}`, `${version}` and
   * `${archive_filename}` left symbolic. Shown to humans; never used to build object keys.
   */
  readonly resolvedPattern: string;
  /** The `${version}` hash of the job this template was compiled for. */
  readonly version: string;
}

/** Encodes a Git ref as one path segment: refs/heads/main becomes refs%2Fheads%2Fmain. */
export function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

/** Forward slashes, no leading slash, and a trailing slash when non-empty. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed && !trimmed.endsWith('/') ? `${trimmed}/` : trimmed;
}

/**
 * Expands `${env.NAME}`, `${NAME}` and `$NAME` in a single pass, so an expanded value is never
 * expanded again. Unset braced names become empty; unset bare names stay literal. Special
 * variables such as `${key}` are left for compileKeyTemplate. A bare special variable (`$ref`
 * rather than `${ref}`) is never expanded from the environment either; its name is recorded in
 * `bareSpecialUses` so the caller can warn about it.
 */
export function expandEnvironment(
  text: string,
  env: NodeJS.ProcessEnv,
  bareSpecialUses?: Set<string>
): string {
  return text.replace(
    /\$\{([A-Za-z0-9_.-]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      if (braced !== undefined) {
        if (SPECIAL_VARIABLES.has(braced)) {
          return match;
        }
        const name = braced.startsWith('env.') ? braced.slice(4) : braced;
        return env[name] ?? '';
      }
      if (SPECIAL_VARIABLES.has(bare as string)) {
        bareSpecialUses?.add(bare as string);
        return match;
      }
      return env[bare as string] ?? match;
    }
  );
}

/**
 * Removes `${name}`. When it is a whole path segment (a `/` or the start of the pattern before it,
 * and a `/` or the end after it), one adjacent `/` goes with it: the one that follows it when
 * present, otherwise the one that precedes it, so no leading, doubled or trailing slash is left
 * behind. Inside a segment, such as `${ref}-${key}`, only the placeholder text is removed.
 */
function removePlaceholder(pattern: string, name: string): string {
  const placeholder = `\${${name}}`;
  let result = pattern;
  let from = 0;
  for (
    let at = result.indexOf(placeholder, from);
    at !== -1;
    at = result.indexOf(placeholder, from)
  ) {
    const after = at + placeholder.length;
    const wholeSegment =
      (at === 0 || result[at - 1] === '/') && (after === result.length || result[after] === '/');
    if (wholeSegment && result[after] === '/') {
      result = result.slice(0, at) + result.slice(after + 1);
      from = at;
    } else if (wholeSegment && at > 0) {
      result = result.slice(0, at - 1) + result.slice(after);
      from = at - 1;
    } else {
      result = result.slice(0, at) + result.slice(after);
      from = at;
    }
  }
  return result;
}

type VaryingPlaceholder = 'ref' | 'version' | 'archive_filename';
type Token =
  | { kind: 'text'; text: string }
  | { kind: 'GITHUB_REPOSITORY' | 'prefix' | 'key' | VaryingPlaceholder };

/** Splits resolved pattern text into literal text and the placeholders it still holds. */
function tokenize(text: string): Token[] {
  return text
    .split(RESOLVED_PLACEHOLDERS)
    .map((part, index) =>
      index % 2 === 0
        ? { kind: 'text', text: part }
        : { kind: part as Exclude<Token['kind'], 'text'> }
    );
}

function tidy(text: string): string {
  return text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

export function compileKeyTemplate(rawOptions: KeyTemplateOptions): KeyTemplate {
  // `${repository}` is an alias of `${GITHUB_REPOSITORY}`. Rewrite it first; `pattern` stays raw.
  const options: KeyTemplateOptions = {
    ...rawOptions,
    pattern: rawOptions.pattern.replaceAll('${repository}', '${GITHUB_REPOSITORY}'),
  };
  const keyCount = options.pattern.split(KEY_PLACEHOLDER).length - 1;
  if (keyCount !== 1) {
    throw new Error(
      `s3-key-pattern must contain \${key} exactly once (found ${keyCount}): "${options.pattern}"`
    );
  }

  const refScopedPattern = options.scopedToRepository
    ? options.pattern
    : removePlaceholder(options.pattern, 'GITHUB_REPOSITORY');
  const pattern = options.scopedToRef
    ? refScopedPattern
    : removePlaceholder(refScopedPattern, 'ref');

  const warnings: string[] = [];
  if (options.scopedToRef && !pattern.includes('${ref}')) {
    warnings.push(
      's3-key-pattern has no ${ref}, so caches are shared by every branch and pull request.'
    );
  }
  if (!pattern.includes('${version}')) {
    warnings.push(
      's3-key-pattern has no ${version}, so a cache saved with different paths or compression can be restored as a hit.'
    );
  }

  const bareSpecialUses = new Set<string>();
  const expandAndSplit = (text: string, uses?: Set<string>): string[] =>
    expandEnvironment(text, options.env ?? process.env, uses).split(KEY_PLACEHOLDER);
  const [before, after] = expandAndSplit(pattern, bareSpecialUses);
  for (const name of bareSpecialUses) {
    warnings.push(
      `s3-key-pattern uses $${name}; write \${${name}} to use the ${name} placeholder.`
    );
  }
  const prefix = normalizePrefix(options.prefix);
  const resolve = (text: string, value: (name: VaryingPlaceholder) => string): string =>
    text.replace(RESOLVED_PLACEHOLDERS, (_match: string, name: string) => {
      switch (name) {
        case 'GITHUB_REPOSITORY':
          return options.repository;
        case 'prefix':
          return prefix;
        default:
          return value(name as VaryingPlaceholder);
      }
    });
  const fill = (text: string, ref: string): string =>
    resolve(text, (name) => {
      switch (name) {
        case 'ref':
          return encodeRef(ref);
        case 'version':
          return options.version;
        default:
          return options.archiveFilename;
      }
    });
  const baseOf = (ref: string): string => tidy(fill(before, ref)).replace(/^\//, '');
  const suffixOf = (ref: string): string => tidy(fill(after, ref));
  // Human-readable form: only the parts that are fixed for the whole job are substituted.
  const resolvedPattern = tidy(
    `${before}${KEY_PLACEHOLDER}${after}`.replace(
      RESOLVED_PLACEHOLDERS,
      (match: string, name: string) => {
        switch (name) {
          case 'GITHUB_REPOSITORY':
            return options.repository;
          case 'prefix':
            return prefix;
          default:
            return match;
        }
      }
    )
  ).replace(/^\//, '');

  // Scope text resolves like baseOf and suffixOf, but leaves the version, the archive filename
  // and (for every ref) the ref as marked wildcards. None of them is ever empty in a saved object
  // key, so tidy treats a mark exactly as it treats the value it stands for.
  const scopeFill = (text: string, ref?: string): string =>
    resolve(text, (name) =>
      name === 'ref' && ref !== undefined ? encodeRef(ref) : `${MARK}${name}${MARK}`
    );
  const scopeBaseOf = (ref?: string): string => tidy(scopeFill(before, ref)).replace(/^\//, '');
  /**
   * The unanchored regex source for the objects `base`/`suffix` text can produce for `ref`, with
   * `groupSuffix` appended to capture group names so two sources can share one RegExp.
   */
  const scopeSource = (
    base: string,
    suffix: string,
    ref: string | undefined,
    groupSuffix: string
  ): string => {
    const captured = new Set<string>();
    const toPattern = (text: string): string =>
      text
        .split(MARK)
        .map((part, index) => {
          if (index % 2 === 0) {
            return escapeRegExp(part);
          }
          if (part === 'archive_filename') {
            return ARCHIVE_FILENAME_PATTERN;
          }
          const group = `${part}${groupSuffix}`;
          if (captured.has(part)) {
            return `\\k<${group}>`;
          }
          captured.add(part);
          return part === 'ref'
            ? `(?<${group}>${escapeRegExp(ENCODED_REF_START)}[^/]+)`
            : `(?<${group}>[^/]+)`;
        })
        .join('');
    const head = tidy(scopeFill(base, ref)).replace(/^\//, '');
    return `${toPattern(head)}.+${toPattern(tidy(scopeFill(suffix, ref)))}`;
  };

  const tokens: Token[] = [...tokenize(before), { kind: 'key' }, ...tokenize(after)];
  const endsSegment = (token: Token): boolean => {
    switch (token.kind) {
      case 'text':
        return /[/\\]/.test(token.text);
      case 'prefix':
        return prefix !== '';
      case 'GITHUB_REPOSITORY':
        return options.repository.includes('/');
      default:
        return false;
    }
  };
  const varies = (token: Token): boolean =>
    token.kind === 'key' || token.kind === 'version' || token.kind === 'ref';
  /**
   * True when the placeholder at `index` shares no path segment with a part of the object key
   * that differs between objects (`${key}`, `${version}` or `${ref}`). Everything else has a
   * fixed number of slashes, so the placeholder then sits at a fixed segment position that
   * another repository's or ref's objects cannot shift. One exception keeps
   * `${GITHUB_REPOSITORY}-${ref}` usable: an encoded full ref starts with `refs%2F` and a
   * repository name cannot contain `%`, so a ref after the repository still ends it unambiguously
   * when no `%` comes in between.
   */
  const isSegmentIsolated = (index: number): boolean => {
    for (let i = index - 1; i >= 0 && !endsSegment(tokens[i]); i--) {
      if (varies(tokens[i])) {
        return false;
      }
    }
    let percentSeen =
      tokens[index].kind !== 'GITHUB_REPOSITORY' || options.repository.includes('%');
    for (let i = index + 1; i < tokens.length && !endsSegment(tokens[i]); i++) {
      const token = tokens[i];
      if (token.kind === 'ref' && !percentSeen) {
        return true;
      }
      if (varies(token)) {
        return false;
      }
      if (token.kind === 'text' && token.text.includes('%')) {
        percentSeen = true;
      }
    }
    return true;
  };
  const indexesOf = (kind: Token['kind']): number[] =>
    tokens.flatMap((token, index) => (token.kind === kind ? [index] : []));

  /** One anchored matcher per ref, built like scopeMatcher's, reused across candidates. */
  const versionMatchers = new Map<string, RegExp>();
  const versionMatcher = (ref: string): RegExp => {
    let matcher = versionMatchers.get(ref);
    if (!matcher) {
      matcher = new RegExp(`^${scopeSource(before, after, ref, '')}$`, 's');
      versionMatchers.set(ref, matcher);
    }
    return matcher;
  };

  return {
    warnings,
    pattern: rawOptions.pattern,
    resolvedPattern,
    version: options.version,
    objectKey: (ref, key) => `${baseOf(ref)}${key}${suffixOf(ref)}`,
    searchPrefix: (ref, keyPrefix) => `${baseOf(ref)}${keyPrefix}`,
    scopePrefix: (ref) => scopeBaseOf(ref).split(MARK)[0],
    scopeMatcher: (ref) => {
      let source = scopeSource(before, after, ref, '');
      if (!options.scopedToRef && refScopedPattern.includes('${ref}')) {
        // Keys saved with scoped-to-ref true can also fit the pattern without its ref (the ref
        // segment reads as the start of the key); leave those to a ref-scoped prune.
        const [scopedBefore, scopedAfter] = expandAndSplit(refScopedPattern);
        source = `(?!${scopeSource(scopedBefore, scopedAfter, undefined, 'Scoped')}$)${source}`;
      }
      return new RegExp(`^${source}$`, 's');
    },
    scopeProblem: (ref) => {
      if (indexesOf('archive_filename').length === 0) {
        return 'no-archive-filename';
      }
      const repositories = indexesOf('GITHUB_REPOSITORY');
      if (
        options.repository !== '' &&
        repositories.length > 0 &&
        !repositories.some((index) => isSegmentIsolated(index))
      ) {
        return 'repository-shares-segment';
      }
      if (ref === undefined) {
        return undefined;
      }
      const refs = indexesOf('ref');
      if (refs.length === 0) {
        return 'no-ref';
      }
      return refs.some((index) => isSegmentIsolated(index)) ? undefined : 'ref-shares-segment';
    },
    extractKey: (ref, objectKey) => {
      const head = baseOf(ref);
      const tail = suffixOf(ref);
      if (
        !objectKey.startsWith(head) ||
        !objectKey.endsWith(tail) ||
        objectKey.length <= head.length + tail.length
      ) {
        return undefined;
      }
      return objectKey.slice(head.length, objectKey.length - tail.length);
    },
    extractVersion: (ref, objectKey) => versionMatcher(ref).exec(objectKey)?.groups?.version,
  };
}
