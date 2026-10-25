import {
  compileKeyTemplate,
  encodeRef,
  type KeyTemplateOptions,
  normalizePrefix,
} from '../../../src/core/keyTemplate';

const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const VERSION = '27747e0d22df7792';
const MAIN = 'refs/heads/main';
const base: KeyTemplateOptions = {
  pattern: PATTERN,
  repository: 'octo/app',
  prefix: '',
  scopedToRepository: true,
  scopedToRef: true,
  version: VERSION,
  archiveFilename: 'cache.tar.zst',
  env: {},
};

describe('compileKeyTemplate', () => {
  it('builds the default object key', () => {
    expect(compileKeyTemplate(base).objectKey(MAIN, 'Linux-npm-abc')).toBe(
      `octo/app/refs%2Fheads%2Fmain/Linux-npm-abc/${VERSION}/cache.tar.zst`
    );
  });

  it('places a normalised prefix before the ref', () => {
    const template = compileKeyTemplate({ ...base, prefix: '\\web//app' });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `octo/app/web/app/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('drops the repository when scoped-to-repository is false', () => {
    const template = compileKeyTemplate({ ...base, scopedToRepository: false });
    expect(template.objectKey(MAIN, 'k')).toBe(`refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);
  });

  describe('${repository} alias', () => {
    const ALIAS = '${repository}/${prefix}${ref}/${key}/${version}/${archive_filename}';

    it('treats ${repository} as ${GITHUB_REPOSITORY}', () => {
      const alias = compileKeyTemplate({ ...base, pattern: ALIAS, repository: 'ws/app' });
      const github = compileKeyTemplate({ ...base, repository: 'ws/app' });
      expect(alias.objectKey(MAIN, 'k')).toBe(github.objectKey(MAIN, 'k'));
      expect(alias.scopeProblem()).toBe(github.scopeProblem());
    });

    it('does not expand ${repository} from the environment', () => {
      const template = compileKeyTemplate({
        ...base,
        pattern: ALIAS,
        repository: 'ws/app',
        env: { repository: 'x' },
      });
      expect(template.objectKey(MAIN, 'k').startsWith('ws/app/')).toBe(true);
    });

    it('keeps the raw pattern text', () => {
      const template = compileKeyTemplate({ ...base, pattern: ALIAS, repository: 'ws/app' });
      expect(template.pattern).toContain('${repository}');
    });

    it('removes ${repository} when scoped-to-repository is false', () => {
      const alias = compileKeyTemplate({
        ...base,
        pattern: ALIAS,
        repository: 'ws/app',
        scopedToRepository: false,
      });
      const github = compileKeyTemplate({
        ...base,
        repository: 'ws/app',
        scopedToRepository: false,
      });
      expect(alias.objectKey(MAIN, 'k')).toBe(github.objectKey(MAIN, 'k'));
      expect(alias.objectKey(MAIN, 'k')).not.toContain('ws/app');
    });
  });

  it('drops the ref when scoped-to-ref is false', () => {
    const template = compileKeyTemplate({ ...base, scopedToRef: false });
    expect(template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    expect(template.objectKey(MAIN, 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    expect(template.warnings).toEqual([]);
  });

  it('encodes a ref as a single path segment', () => {
    expect(encodeRef('refs/pull/12/merge')).toBe('refs%2Fpull%2F12%2Fmerge');
  });

  it('inserts keys verbatim and reads them back, even with slashes and dollar signs', () => {
    const template = compileKeyTemplate({ ...base, env: { HOME: '/home/runner' } });
    const key = 'Linux/node-20/$HOME-${HOME}';
    const objectKey = template.objectKey(MAIN, key);
    expect(objectKey).toBe(`octo/app/refs%2Fheads%2Fmain/${key}/${VERSION}/cache.tar.zst`);
    expect(template.extractKey(MAIN, objectKey)).toBe(key);
  });

  it('expands environment references in the pattern', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern:
        '${GITHUB_REPOSITORY}/${RUNNER_OS}/$WORKLOAD/${env.JOB}/${ref}/${key}/${version}/${archive_filename}',
      env: { RUNNER_OS: 'Linux', WORKLOAD: 'api', JOB: 'build' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `octo/app/Linux/api/build/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('empties an unset braced variable and keeps an unset bare one literal', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${MISSING}/$ALSO_MISSING/${ref}/${key}/${version}/${archive_filename}',
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `$ALSO_MISSING/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('never expands an environment value a second time', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${A}/${ref}/${key}/${version}/${archive_filename}',
      env: { A: '$B', B: 'nope' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(`$B/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);
  });

  it.each([
    ['${ref}/${archive_filename}', 0],
    ['${key}/${key}/${archive_filename}', 2],
  ])('rejects %s', (pattern, count) => {
    expect(() => compileKeyTemplate({ ...base, pattern })).toThrow(
      `s3-key-pattern must contain \${key} exactly once (found ${count})`
    );
  });

  it('warns when the pattern can scope by neither ref nor version', () => {
    const template = compileKeyTemplate({ ...base, pattern: '${key}/${archive_filename}' });
    expect(template.warnings).toEqual([
      expect.stringContaining('${ref}'),
      expect.stringContaining('${version}'),
    ]);
  });

  it('builds search prefixes that end in the key prefix', () => {
    expect(compileKeyTemplate(base).searchPrefix(MAIN, 'Linux-npm-')).toBe(
      'octo/app/refs%2Fheads%2Fmain/Linux-npm-'
    );
  });

  describe('extractKey', () => {
    const template = compileKeyTemplate(base);
    const root = 'octo/app/refs%2Fheads%2Fmain';

    it('returns the key of an object that matches the template', () => {
      expect(template.extractKey(MAIN, `${root}/Linux-npm-abc/${VERSION}/cache.tar.zst`)).toBe(
        'Linux-npm-abc'
      );
    });

    it.each([
      ['another version', `${root}/k/ffffffffffffffff/cache.tar.zst`],
      ['another archive format', `${root}/k/${VERSION}/cache.tar.gz`],
      ['another ref', `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`],
      ['an empty key', `${root}//${VERSION}/cache.tar.zst`],
    ])('rejects an object with %s', (_label, objectKey) => {
      expect(template.extractKey(MAIN, objectKey)).toBeUndefined();
    });
  });
});

describe('placeholder removal', () => {
  it('removes only the placeholder text when ${GITHUB_REPOSITORY} or ${ref} is not a whole path segment', () => {
    const pattern = 'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}';

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: true,
        scopedToRef: true,
      }).objectKey(MAIN, 'k')
    ).toBe(`builds/octo/app-refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: false,
        scopedToRef: true,
      }).objectKey(MAIN, 'k')
    ).toBe(`builds/-refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: true,
        scopedToRef: false,
      }).objectKey('', 'k')
    ).toBe(`builds/octo/app-/k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: false,
        scopedToRef: false,
      }).objectKey('', 'k')
    ).toBe(`builds/-/k/${VERSION}/cache.tar.zst`);
  });

  it('keeps the slash before a ${ref} that shares its segment with other text, as v1.1 did', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: 'cache/${ref}-${key}/${archive_filename}',
      scopedToRef: false,
    });
    expect(template.objectKey('', 'K')).toBe('cache/-K/cache.tar.zst');
  });

  it('keeps the slash before a ${GITHUB_REPOSITORY} glued to ${ref}, as v1.1 did', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: 'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}',
      scopedToRepository: false,
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `builds/-refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('pins the default-pattern object keys for every scope combination', () => {
    const keys = [true, false].flatMap((scopedToRepository) =>
      [true, false].flatMap((scopedToRef) =>
        ['', 'web'].map((prefix) =>
          compileKeyTemplate({ ...base, prefix, scopedToRepository, scopedToRef }).objectKey(
            MAIN,
            'Linux/k'
          )
        )
      )
    );
    expect(keys).toEqual([
      `octo/app/refs%2Fheads%2Fmain/Linux/k/${VERSION}/cache.tar.zst`,
      `octo/app/web/refs%2Fheads%2Fmain/Linux/k/${VERSION}/cache.tar.zst`,
      `octo/app/Linux/k/${VERSION}/cache.tar.zst`,
      `octo/app/web/Linux/k/${VERSION}/cache.tar.zst`,
      `refs%2Fheads%2Fmain/Linux/k/${VERSION}/cache.tar.zst`,
      `web/refs%2Fheads%2Fmain/Linux/k/${VERSION}/cache.tar.zst`,
      `Linux/k/${VERSION}/cache.tar.zst`,
      `web/Linux/k/${VERSION}/cache.tar.zst`,
    ]);
  });

  it('never leaves a leading slash when ${ref} opens the pattern', () => {
    const pattern = '${ref}/${key}';

    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: true }).objectKey(MAIN, 'k')).toBe(
      `refs%2Fheads%2Fmain/k`
    );
    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: false }).objectKey('', 'k')).toBe(
      'k'
    );
  });

  it('never leaves a doubled slash when ${ref} sits between ${key} and a following segment', () => {
    const pattern = '${key}/${ref}/${archive_filename}';

    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: true }).objectKey(MAIN, 'k')).toBe(
      'k/refs%2Fheads%2Fmain/cache.tar.zst'
    );
    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: false }).objectKey('', 'k')).toBe(
      'k/cache.tar.zst'
    );
  });

  it('drops ${ref} cleanly when it is glued to ${prefix} with no slash between them', () => {
    const pattern = '${prefix}${ref}/${key}/${archive_filename}';

    expect(
      compileKeyTemplate({ ...base, pattern, prefix: 'team-a', scopedToRef: true }).objectKey(
        MAIN,
        'k'
      )
    ).toBe('team-a/refs%2Fheads%2Fmain/k/cache.tar.zst');
    expect(
      compileKeyTemplate({ ...base, pattern, prefix: 'team-a', scopedToRef: false }).objectKey(
        '',
        'k'
      )
    ).toBe('team-a/k/cache.tar.zst');
  });
});

describe('bare special variables', () => {
  it('keeps a bare special variable literal instead of expanding it from the environment', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${GITHUB_REPOSITORY}/$ref/${key}/${version}/${archive_filename}',
      env: { ref: 'should-not-be-used' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(`octo/app/$ref/k/${VERSION}/cache.tar.zst`);
  });

  it('never substitutes a bare ${GITHUB_REPOSITORY}, even though the real env var is set', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '$GITHUB_REPOSITORY/${ref}/${key}/${version}/${archive_filename}',
      env: { GITHUB_REPOSITORY: 'someone/else' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `$GITHUB_REPOSITORY/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('warns once per distinct bare special variable', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${ref}/$key/${key}/$ref/${version}/${archive_filename}',
    });
    expect(template.warnings).toEqual([
      's3-key-pattern uses $key; write ${key} to use the key placeholder.',
      's3-key-pattern uses $ref; write ${ref} to use the ref placeholder.',
    ]);
  });

  it('does not warn about an ordinary bare environment reference', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '$RUNNER_OS/${ref}/${key}/${version}/${archive_filename}',
      env: { RUNNER_OS: 'Linux' },
    });
    expect(template.warnings).toEqual([]);
  });
});

describe('scopePrefix', () => {
  it('equals searchPrefix(ref, "") for a given ref', () => {
    const template = compileKeyTemplate(base);
    expect(template.scopePrefix(MAIN)).toBe(template.searchPrefix(MAIN, ''));
    expect(template.scopePrefix(MAIN)).toBe('octo/app/refs%2Fheads%2Fmain/');
  });

  it('resolves the text before ${ref} for every ref when no ref is given', () => {
    const template = compileKeyTemplate(base);
    expect(template.scopePrefix()).toBe('octo/app/');
  });

  it('equals searchPrefix("", "") for an unscoped pattern', () => {
    const template = compileKeyTemplate({ ...base, scopedToRef: false });
    expect(template.scopePrefix()).toBe(template.searchPrefix('', ''));
    expect(template.scopePrefix()).toBe('octo/app/');
    expect(template.scopePrefix(MAIN)).toBe(template.searchPrefix('', ''));
  });

  it('applies the same normalisation as the base for a custom pattern', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${prefix}${ref}/${key}/${archive_filename}',
      prefix: 'team-a',
    });
    expect(template.scopePrefix()).toBe('team-a/');
    expect(template.scopePrefix(MAIN)).toBe('team-a/refs%2Fheads%2Fmain/');
  });
});

describe('normalizePrefix', () => {
  it.each([
    ['', ''],
    ['a', 'a/'],
    ['/a/b/', 'a/b/'],
    ['\\a\\b', 'a/b/'],
  ])('normalises "%s" to "%s"', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected);
  });
});

describe('scope matching', () => {
  const pruneBase: KeyTemplateOptions = { ...base, repository: 'acme/app', version: '' };

  it('lists under the fixed text before the first wildcard', () => {
    const template = compileKeyTemplate({
      ...pruneBase,
      pattern: '${GITHUB_REPOSITORY}/${version}/${ref}/${key}/${archive_filename}',
    });
    expect(template.scopePrefix()).toBe('acme/app/');
    expect(template.scopePrefix(MAIN)).toBe('acme/app/');
  });

  it('matches the whole default-pattern key for one ref, with any key, version and archive', () => {
    const matcher = compileKeyTemplate(pruneBase).scopeMatcher(MAIN);
    expect(matcher.source).toBe(
      '^acme\\/app\\/refs%2Fheads%2Fmain\\/.+\\/(?<version>[^/]+)\\/(?:cache\\.tar\\.zst|cache\\.tar\\.gz)$'
    );
    expect(matcher.test(`acme/app/refs%2Fheads%2Fmain/a/b/${VERSION}/cache.tar.gz`)).toBe(true);
    expect(matcher.test(`xacme/app/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`)).toBe(false);
    expect(matcher.test(`acme/app/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst.1`)).toBe(false);
  });

  it('matches every full ref as one segment, and a repeated placeholder as the same value', () => {
    const matcher = compileKeyTemplate({
      ...pruneBase,
      pattern: '${GITHUB_REPOSITORY}/${ref}/${key}/${ref}/${archive_filename}',
    }).scopeMatcher();
    expect(matcher.test('acme/app/refs%2Fheads%2Fa/k/refs%2Fheads%2Fa/cache.tar.zst')).toBe(true);
    expect(matcher.test('acme/app/refs%2Fheads%2Fa/k/refs%2Fheads%2Fb/cache.tar.zst')).toBe(false);
    expect(matcher.test('acme/app/main/k/main/cache.tar.zst')).toBe(false);
  });

  it('resolves placeholders removed by scoping the way object keys do', () => {
    const options: KeyTemplateOptions = {
      ...pruneBase,
      pattern: '${prefix}${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}',
      scopedToRepository: false,
      prefix: 'web',
    };
    const template = compileKeyTemplate(options);
    const saved = compileKeyTemplate({ ...options, version: VERSION }).objectKey(MAIN, 'a/b');
    expect(saved).toBe(`web/-refs%2Fheads%2Fmain/a/b/${VERSION}/cache.tar.zst`);
    expect(template.scopePrefix(MAIN)).toBe('web/-refs%2Fheads%2Fmain/');
    expect(template.scopeMatcher(MAIN).test(saved)).toBe(true);
  });

  it.each([
    ['${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}', undefined],
    ['${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}', MAIN],
    ['builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}', MAIN],
    ['shared/${key}/${GITHUB_REPOSITORY}/${archive_filename}', undefined],
    ['${ref}/x-${GITHUB_REPOSITORY}.y/${key}/${archive_filename}', MAIN],
  ])('finds no scope problem in %s (ref %s)', (pattern, ref) => {
    expect(compileKeyTemplate({ ...pruneBase, pattern }).scopeProblem(ref)).toBeUndefined();
  });

  it.each([
    ['c/${key}-${GITHUB_REPOSITORY}/${archive_filename}', undefined, 'repository-shares-segment'],
    [
      'c/${GITHUB_REPOSITORY}-%-${ref}/${key}/${archive_filename}',
      undefined,
      'repository-shares-segment',
    ],
    ['c/${ref}${GITHUB_REPOSITORY}/${key}/${archive_filename}', MAIN, 'repository-shares-segment'],
    [
      '${GITHUB_REPOSITORY}/${ref}.${version}/${key}/${archive_filename}',
      MAIN,
      'ref-shares-segment',
    ],
    ['${GITHUB_REPOSITORY}/${key}/${archive_filename}', MAIN, 'no-ref'],
    ['${GITHUB_REPOSITORY}/${ref}/${key}.tar.zst', undefined, 'no-archive-filename'],
  ])('reports a scope problem in %s (ref %s)', (pattern, ref, problem) => {
    expect(compileKeyTemplate({ ...pruneBase, pattern }).scopeProblem(ref)).toBe(problem);
  });

  it('with scoped-to-ref false, matches keys without a ref and rejects ref-scoped keys', () => {
    const template = compileKeyTemplate({ ...pruneBase, scopedToRef: false });
    const matcher = template.scopeMatcher();
    expect(template.scopePrefix()).toBe('acme/app/');
    expect(template.scopeProblem()).toBeUndefined();
    expect(matcher.test(`acme/app/Linux/k/${VERSION}/cache.tar.zst`)).toBe(true);
    expect(matcher.test(`acme/app/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`)).toBe(false);
    expect(matcher.test(`acme/app/refs%2Fheads%2Fmain/${VERSION}/cache.tar.zst`)).toBe(true);
  });

  it('does not check the repository once scoped-to-repository removed it', () => {
    const template = compileKeyTemplate({
      ...pruneBase,
      pattern: 'c/${key}-${GITHUB_REPOSITORY}/${ref}/${archive_filename}',
      scopedToRepository: false,
    });
    expect(template.scopeProblem()).toBeUndefined();
  });
});

describe('introspection', () => {
  it('keeps the raw pattern and the job version', () => {
    const template = compileKeyTemplate(base);
    expect(template.pattern).toBe(PATTERN);
    expect(template.version).toBe(VERSION);
  });

  it('resolves the repository and prefix but leaves key, version and filename symbolic', () => {
    const template = compileKeyTemplate({ ...base, prefix: 'web' });
    expect(template.resolvedPattern).toBe(
      'octo/app/web/${ref}/${key}/${version}/${archive_filename}'
    );
  });

  it('drops the placeholders the scoping options remove', () => {
    const template = compileKeyTemplate({ ...base, scopedToRepository: false, scopedToRef: false });
    expect(template.resolvedPattern).toBe('${key}/${version}/${archive_filename}');
  });

  describe('extractVersion', () => {
    it('reads the version out of an object key', () => {
      expect(
        compileKeyTemplate(base).extractVersion(
          MAIN,
          `octo/app/refs%2Fheads%2Fmain/k/other-version/cache.tar.gz`
        )
      ).toBe('other-version');
    });

    it('reads the version when the key itself contains slashes', () => {
      expect(
        compileKeyTemplate(base).extractVersion(
          MAIN,
          `octo/app/refs%2Fheads%2Fmain/a/b/c/other-version/cache.tar.zst`
        )
      ).toBe('other-version');
    });

    it('returns undefined for a key that does not fit the pattern', () => {
      const template = compileKeyTemplate(base);
      expect(template.extractVersion(MAIN, 'octo/app/refs%2Fheads%2Fmain/k/v/notes.txt')).toBe(
        undefined
      );
      expect(
        template.extractVersion(MAIN, 'other/repo/refs%2Fheads%2Fmain/k/v/cache.tar.zst')
      ).toBe(undefined);
    });

    it('returns undefined when the pattern has no version', () => {
      const template = compileKeyTemplate({
        ...base,
        pattern: '${GITHUB_REPOSITORY}/${ref}/${key}/${archive_filename}',
      });
      expect(template.extractVersion(MAIN, 'octo/app/refs%2Fheads%2Fmain/k/cache.tar.zst')).toBe(
        undefined
      );
    });
  });
});
