import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BitbucketHost } from '../../../src/ci/bitbucket';
import { TextSummaryWriter } from '../../../src/ci/textSummary';
import type { GenericHostOptions } from '../../../src/ci/generic';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bb-host-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  jest.restoreAllMocks();
});

const BRANCH_ENV = {
  BITBUCKET_REPO_FULL_NAME: 'ws/app',
  BITBUCKET_BRANCH: 'feature/x',
  BITBUCKET_CLONE_DIR: '/b',
  BITBUCKET_BUILD_NUMBER: '7',
};
const PR_ENV = {
  ...BRANCH_ENV,
  BITBUCKET_PR_ID: '42',
  BITBUCKET_PR_DESTINATION_BRANCH: 'develop',
};

function host(
  env: NodeJS.ProcessEnv,
  options: Partial<GenericHostOptions & { allowRefOverride?: boolean }> = {}
) {
  return new BitbucketHost({
    inputs: {},
    defaults: {},
    env,
    stateFile: join(dir, 'state.json'),
    ...options,
  });
}

function spyOut() {
  return jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
}
function spyErr() {
  return jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('BitbucketHost context', () => {
  it('maps a branch build', () => {
    spyOut();
    const ctx = host(BRANCH_ENV).context();
    expect(ctx.platform).toBe('bitbucket');
    expect(ctx.repository).toBe('ws/app');
    expect(ctx.refs.current).toBe('refs/heads/feature/x');
    expect(ctx.refs.restore).toEqual(['refs/heads/feature/x', 'refs/heads/main']);
    expect(ctx.workspace).toBe('/b');
    expect(ctx.eventName).toBe('push');
    expect(ctx.labels).toMatchObject({ stepSize: 'unknown' });
  });

  it('maps a pull request build', () => {
    spyOut();
    const ctx = host(PR_ENV).context();
    expect(ctx.refs.current).toBe('refs/pull/42/merge');
    expect(ctx.refs.restore).toEqual([
      'refs/pull/42/merge',
      'refs/heads/develop',
      'refs/heads/main',
    ]);
    expect(ctx.eventName).toBe('pull_request');
  });

  it('uses the tag ref for a tag build', () => {
    spyOut();
    const ctx = host({ ...BRANCH_ENV, BITBUCKET_TAG: 'v1.0.0' }).context();
    expect(ctx.refs.current).toBe('refs/tags/v1.0.0');
  });

  it('has no ref for a custom run', () => {
    spyOut();
    const { BITBUCKET_BRANCH: _b, ...env } = BRANCH_ENV;
    expect(host(env).context().refs).toEqual({ current: undefined, restore: [] });
  });

  it('workspace falls back to CLOUD_CACHE_WORKSPACE, then cwd', () => {
    spyOut();
    const { BITBUCKET_CLONE_DIR: _c, ...env } = BRANCH_ENV;
    expect(host({ ...env, CLOUD_CACHE_WORKSPACE: '/w' }).context().workspace).toBe('/w');
    expect(host(env).context().workspace).toBe(process.cwd());
  });

  it('ignores CLOUD_CACHE_EVENT_NAME', () => {
    spyOut();
    expect(host({ ...BRANCH_ENV, CLOUD_CACHE_EVENT_NAME: 'x' }).context().eventName).toBe('push');
  });

  it('reads CLOUD_CACHE_DEFAULT_BRANCH and logs it once', () => {
    const out = spyOut();
    const h = host({ ...BRANCH_ENV, CLOUD_CACHE_DEFAULT_BRANCH: 'master' });
    expect(h.context().refs.restore.at(-1)).toBe('refs/heads/master');
    h.context();
    const lines = out.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('Default branch'));
    expect(lines).toEqual(['Default branch: master\n']);
  });

  it('names the default when no variable is set', () => {
    const out = spyOut();
    host(BRANCH_ENV).context();
    expect(out.mock.calls.map((c) => String(c[0]))).toContain(
      'Default branch: main (set CLOUD_CACHE_DEFAULT_BRANCH to change it)\n'
    );
  });

  it('warns once when the repository is empty', () => {
    spyOut();
    const err = spyErr();
    const h = host({ BITBUCKET_BUILD_NUMBER: '1' });
    h.context();
    h.context();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('BITBUCKET_REPO_FULL_NAME');
  });

  it('ignores the override variables and warns once', () => {
    spyOut();
    const err = spyErr();
    const h = host({
      ...PR_ENV,
      CLOUD_CACHE_REF: 'refs/heads/main',
      CLOUD_CACHE_REPOSITORY: 'other/repo',
    });
    const ctx = h.context();
    h.context();
    expect(ctx.refs.current).toBe('refs/pull/42/merge');
    expect(ctx.repository).toBe('ws/app');
    expect(err).toHaveBeenCalledTimes(1);
    const text = String(err.mock.calls[0]?.[0]);
    expect(text).toContain('CLOUD_CACHE_REF');
    expect(text).toContain('CLOUD_CACHE_REPOSITORY');
    expect(text).toContain('--allow-ref-override');
  });

  it('uses the override values when allowed and logs them', () => {
    const out = spyOut();
    const err = spyErr();
    const ctx = host(
      {
        ...PR_ENV,
        CLOUD_CACHE_REF: 'refs/heads/main',
        CLOUD_CACHE_BASE_REF: 'trunk',
        CLOUD_CACHE_REPOSITORY: 'other/repo',
      },
      { allowRefOverride: true }
    ).context();
    expect(ctx.refs.current).toBe('refs/heads/main');
    expect(ctx.refs.restore).toContain('refs/heads/trunk');
    expect(ctx.repository).toBe('other/repo');
    expect(err).not.toHaveBeenCalled();
    const text = out.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('CLOUD_CACHE_REF=refs/heads/main');
    expect(text).toContain('CLOUD_CACHE_BASE_REF=trunk');
    expect(text).toContain('CLOUD_CACHE_REPOSITORY=other/repo');
  });

  it('input never reads the context env names', () => {
    expect(host({ ...BRANCH_ENV, CLOUD_CACHE_REF: 'x' }).input('ref')).toBe('');
  });
});

describe('BitbucketHost outputs and summary', () => {
  it('appends CLOUD_CACHE_ variables to the variables file', () => {
    spyOut();
    const vars = join(dir, 'vars.env');
    const outputs = join(dir, 'outputs.txt');
    const h = host(
      { ...BRANCH_ENV, BITBUCKET_PIPELINES_VARIABLES_PATH: vars },
      { outputsFile: outputs }
    );
    h.setOutput('cache-hit', 'true');
    h.setOutput('multi', 'a\nb');
    h.setOutput('crlf', 'a\rb');
    expect(readFileSync(vars, 'utf8')).toBe('CLOUD_CACHE_CACHE_HIT=true\n');
    expect(readFileSync(outputs, 'utf8')).toContain('cache-hit=true\n');
    expect(readFileSync(outputs, 'utf8')).toContain('multi<<');
  });

  it('has a text summary writer', () => {
    expect(host(BRANCH_ENV).summary).toBeInstanceOf(TextSummaryWriter);
  });
});

describe('BitbucketHost labels', () => {
  it('sets the runner labels from the step size', () => {
    const labels = host({ ...BRANCH_ENV, BITBUCKET_STEP_SIZE: '4x' }).context().labels;
    expect(labels).toMatchObject({ stepSize: '4x', cpus: expect.any(Number) });
  });

  it('computes the labels once per host', () => {
    const h = host(BRANCH_ENV);
    expect(h.context().labels).toBe(h.context().labels);
  });
});
