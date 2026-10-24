/** The workspace directory: GITHUB_WORKSPACE, or the current directory. */
export function getWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_WORKSPACE || process.cwd();
}

/** The values of `runner.os` on GitHub-hosted and self-hosted runners. */
export type RunnerOs = 'Linux' | 'macOS' | 'Windows';

/** `runner.os` from RUNNER_OS, or from the platform when RUNNER_OS is not a known value. */
export function runnerOs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): RunnerOs {
  const fromEnv = env.RUNNER_OS;
  if (fromEnv === 'Linux' || fromEnv === 'macOS' || fromEnv === 'Windows') {
    return fromEnv;
  }
  if (platform === 'win32') {
    return 'Windows';
  }
  return platform === 'darwin' ? 'macOS' : 'Linux';
}
