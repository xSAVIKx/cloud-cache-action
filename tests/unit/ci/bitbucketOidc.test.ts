import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setupBitbucketOidc } from '../../../src/ci/bitbucketOidc';

const TOKEN = 'tok-123';
const ARN = 'arn:aws:iam::1:role/r';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(env: NodeJS.ProcessEnv, extra: { roleArn?: string; hasAccessKey?: boolean } = {}) {
  const lines: string[] = [];
  const push = (m: string) => void lines.push(m);
  const log = {
    debug: push,
    info: push,
    warning: push,
    error: push,
    startGroup: push,
    endGroup: () => undefined,
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'oidc-test-'));
  roots.push(tmpDir);
  const result = setupBitbucketOidc({
    env,
    hasAccessKey: false,
    ...extra,
    log,
    tmpDir,
  });
  return { result, lines, tmpDir };
}

describe('setupBitbucketOidc', () => {
  it('writes the token to a 0600 file and sets the AWS variables', () => {
    const env: NodeJS.ProcessEnv = {
      BITBUCKET_STEP_OIDC_TOKEN: TOKEN,
      BITBUCKET_BUILD_NUMBER: '7',
    };
    const { result, lines } = setup(env, { roleArn: ARN });
    expect(result).toBeDefined();
    const file = env.AWS_WEB_IDENTITY_TOKEN_FILE as string;
    expect(readFileSync(file, 'utf8')).toBe(TOKEN);
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(env.AWS_ROLE_ARN).toBe(ARN);
    expect(env.AWS_ROLE_SESSION_NAME).toBe('cloud-cache-7');
    const dir = dirname(file);
    result?.cleanup();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(() => result?.cleanup()).not.toThrow();
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('takes the role ARN from CLOUD_CACHE_ROLE_ARN, then AWS_ROLE_ARN', () => {
    const a: NodeJS.ProcessEnv = {
      BITBUCKET_STEP_OIDC_TOKEN: TOKEN,
      CLOUD_CACHE_ROLE_ARN: 'arn:a',
      AWS_ROLE_ARN: 'arn:b',
    };
    expect(setup(a).result).toBeDefined();
    expect(a.AWS_ROLE_ARN).toBe('arn:a');
    const b: NodeJS.ProcessEnv = {
      BITBUCKET_STEP_OIDC_TOKEN: TOKEN,
      AWS_ROLE_ARN: 'arn:b',
    };
    expect(setup(b).result).toBeDefined();
    expect(b.AWS_ROLE_ARN).toBe('arn:b');
  });

  it('does nothing without a token', () => {
    const env: NodeJS.ProcessEnv = {};
    const { result } = setup(env, { roleArn: ARN });
    expect(result).toBeUndefined();
    expect(env).toEqual({});
  });

  it('does nothing when an access key is given', () => {
    const env: NodeJS.ProcessEnv = { BITBUCKET_STEP_OIDC_TOKEN: TOKEN };
    const { result, lines } = setup(env, { roleArn: ARN, hasAccessKey: true });
    expect(result).toBeUndefined();
    expect(env).toEqual({ BITBUCKET_STEP_OIDC_TOKEN: TOKEN });
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('leaves an existing token file setting alone', () => {
    const env: NodeJS.ProcessEnv = {
      BITBUCKET_STEP_OIDC_TOKEN: TOKEN,
      AWS_WEB_IDENTITY_TOKEN_FILE: '/x/token',
    };
    const { result } = setup(env, { roleArn: ARN });
    expect(result).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBe('/x/token');
    expect(env.AWS_ROLE_ARN).toBeUndefined();
  });

  it('skips with one info line when no role ARN is set', () => {
    const env: NodeJS.ProcessEnv = { BITBUCKET_STEP_OIDC_TOKEN: TOKEN };
    const { result, lines } = setup(env);
    expect(result).toBeUndefined();
    expect(env).toEqual({ BITBUCKET_STEP_OIDC_TOKEN: TOKEN });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/OIDC.*skipped.*role ARN/i);
    expect(lines[0]).not.toContain(TOKEN);
  });

  it('leaves no env change when the write fails', () => {
    const env: NodeJS.ProcessEnv = { BITBUCKET_STEP_OIDC_TOKEN: TOKEN };
    const lines: string[] = [];
    const push = (m: string) => void lines.push(m);
    const log = {
      debug: push,
      info: push,
      warning: push,
      error: push,
      startGroup: push,
      endGroup: () => undefined,
    };
    const result = setupBitbucketOidc({
      env,
      roleArn: ARN,
      hasAccessKey: false,
      log,
      tmpDir: '/nonexistent-dir-for-oidc-test',
    });
    expect(result).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AWS_ROLE_ARN).toBeUndefined();
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
