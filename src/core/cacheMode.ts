/**
 * The runner exports ACTIONS_CACHE_MODE to tell a job what it may do with a cache. @actions/cache
 * 6.3.0 reads it for the GitHub tier. These functions copy its parsing (internal/config.js), so
 * the S3 tier obeys the same value in the same way.
 */

/** The cache-mode lattice: readable = {read, write}, writable = {write, write-only}. */
const KNOWN_CACHE_MODES = ['none', 'read', 'write', 'write-only'];

/** The effective cache mode, trimmed and in lower case, or '' when the variable is not set. */
export function getCacheMode(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ACTIONS_CACHE_MODE || '').trim().toLowerCase();
}

/** An unset or unknown mode permits reads, as in @actions/cache. */
export function isCacheReadable(mode: string): boolean {
  if (!KNOWN_CACHE_MODES.includes(mode)) {
    return true;
  }
  return mode === 'read' || mode === 'write';
}

/** An unset or unknown mode permits writes, as in @actions/cache. */
export function isCacheWritable(mode: string): boolean {
  if (!KNOWN_CACHE_MODES.includes(mode)) {
    return true;
  }
  return mode === 'write' || mode === 'write-only';
}

/**
 * Why the GitHub Actions cache service is not available to this process, or undefined when it is.
 * A copy of isFeatureAvailable and getCacheServiceVersion in @actions/cache 6.3.0
 * (cache.js, internal/config.js). The copy keeps @actions/cache out of S3-only runs. The service
 * version is v2 when ACTIONS_CACHE_SERVICE_V2 is set, except on GHES, which always uses v1. The
 * runner sets the service URLs for JavaScript and container actions only. A `run:` step and every
 * CI system other than GitHub Actions have neither.
 */
export function gitHubCacheServiceProblem(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const v2 = Boolean(env.ACTIONS_CACHE_SERVICE_V2) && !isGhes(env);
  const name = v2 ? 'ACTIONS_RESULTS_URL' : 'ACTIONS_CACHE_URL';
  if (env[name]) {
    return undefined;
  }
  return (
    `GitHub Actions Cache is not available: ${name} is not set (cache service ${v2 ? 'v2' : 'v1'}). ` +
    'The runner sets it only for JavaScript and container actions. A run: step and other CI ' +
    'systems do not have it.'
  );
}

/** True when the runner gives the GitHub Actions cache service to this process. */
export function isGitHubCacheServiceAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitHubCacheServiceProblem(env) === undefined;
}

/** A copy of isGhes in @actions/cache 6.3.0 (internal/config.js). */
function isGhes(env: NodeJS.ProcessEnv): boolean {
  let hostname: string;
  try {
    hostname = new URL(env.GITHUB_SERVER_URL || 'https://github.com').hostname
      .trimEnd()
      .toUpperCase();
  } catch {
    // @actions/cache throws here. Report v1, so the message names ACTIONS_CACHE_URL.
    return true;
  }
  return !(
    hostname === 'GITHUB.COM' ||
    hostname.endsWith('.GHE.COM') ||
    hostname.endsWith('.LOCALHOST')
  );
}

/** The GitHub tier fails at once with this error when the service is not available. */
export class GitHubCacheUnavailableError extends Error {
  override name = 'GitHubCacheUnavailableError';
}
