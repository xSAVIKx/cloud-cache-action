import { readFileSync } from 'node:fs';
import * as os from 'node:os';

export type RunnerLabels = {
  stepSize: string;
  cpus: number;
  memoryLimitBytes?: number;
};

const CGROUP_V2_MEMORY = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_MEMORY = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

function readLimit(readFile: (file: string) => string, file: string): number | undefined {
  try {
    const text = readFile(file).trim();
    if (!/^\d+$/.test(text)) {
      return undefined;
    }
    const value = Number(text);
    // Cgroup v1 reports a number near 2^63 when there is no limit.
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The labels that describe the runner: Bitbucket step size, CPU count and memory limit. */
export function runnerLabels(
  env: NodeJS.ProcessEnv,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')
): RunnerLabels {
  const labels: RunnerLabels = {
    stepSize: env.BITBUCKET_STEP_SIZE || 'unknown',
    cpus: os.availableParallelism(),
  };
  const memory = readLimit(readFile, CGROUP_V2_MEMORY) ?? readLimit(readFile, CGROUP_V1_MEMORY);
  if (memory !== undefined) {
    labels.memoryLimitBytes = memory;
  }
  return labels;
}
