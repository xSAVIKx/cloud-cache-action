import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CiLogger } from './host';

export interface BitbucketOidcOptions {
  /** The environment to read and change. The caller passes `process.env`. */
  env: NodeJS.ProcessEnv;
  roleArn?: string;
  hasAccessKey: boolean;
  log: CiLogger;
  tmpDir?: string;
}

/**
 * Prepares the AWS web identity variables from the Bitbucket OIDC token.
 * The SDK default credential chain then reads them. The token is never logged.
 */
export function setupBitbucketOidc(options: BitbucketOidcOptions): { cleanup(): void } | undefined {
  const { env, hasAccessKey, log } = options;
  const token = env.BITBUCKET_STEP_OIDC_TOKEN;
  if (!token || hasAccessKey || env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    return undefined;
  }
  const roleArn = options.roleArn || env.CLOUD_CACHE_ROLE_ARN || env.AWS_ROLE_ARN;
  if (!roleArn) {
    log.info('OIDC is skipped because no role ARN is set.');
    return undefined;
  }

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(options.tmpDir ?? tmpdir(), 'cloud-cache-oidc-'));
    const file = join(dir, 'token');
    writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
    env.AWS_WEB_IDENTITY_TOKEN_FILE = file;
  } catch (error) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    log.warning(`OIDC is skipped because the token file cannot be written (${code}).`);
    return undefined;
  }
  env.AWS_ROLE_ARN = roleArn;
  const build = env.BITBUCKET_BUILD_NUMBER;
  env.AWS_ROLE_SESSION_NAME = build ? `cloud-cache-${build}` : 'cloud-cache';
  log.info('Using the Bitbucket OIDC token for AWS credentials.');

  const root = dir;
  return {
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
