import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const coreImport = {
  name: '@actions/core',
  message:
    'Import @actions/core only in src/ci/github.ts and src/state.ts. Use the CiHost port from src/ci/host.ts.',
};
const cacheImport = {
  name: '@actions/cache',
  message: 'Import @actions/cache only in src/core/githubTier.ts.',
};
// `paths` matches only the package name; `patterns` also matches deep imports such as
// `@actions/core/lib/summary`.
const corePattern = { group: ['@actions/core/*'], message: coreImport.message };
const cachePattern = { group: ['@actions/cache/*'], message: cacheImport.message };
const CI_ENV = '/^(GITHUB|RUNNER)_/';
const CI_ENV_MESSAGE =
  'Do not read GITHUB_* or RUNNER_* environment variables outside src/ci. Add the read to a CiHost in src/ci.';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
      '*.config.js',
      '*.config.mjs',
    ],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [coreImport, cacheImport], patterns: [corePattern, cachePattern] },
      ],
    },
  },
  {
    files: ['src/ci/github.ts', 'src/state.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [cacheImport], patterns: [cachePattern] }],
    },
  },
  {
    files: ['src/core/githubTier.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [coreImport], patterns: [corePattern] }],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/ci/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `MemberExpression[object.object.name='process'][object.property.name='env'][computed=false][property.name=${CI_ENV}]`,
          message: CI_ENV_MESSAGE,
        },
        {
          selector: `MemberExpression[object.object.name='process'][object.property.name='env'][computed=true][property.value=${CI_ENV}]`,
          message: CI_ENV_MESSAGE,
        },
      ],
    },
  }
);
