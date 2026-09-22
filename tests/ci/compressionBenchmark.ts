/**
 * Measures how zstd's compression level changes archive size, compress time and extract time
 * against real dependency trees (the transfer benchmark in `benchmark.ts` uses random bytes,
 * which never compress, so this is the only benchmark that exercises compression at all).
 *
 * Builds each archive through the real `buildCreateCommands` plan from `src/archive/tar.ts`, so
 * the measured command is the one the action actually runs.
 *
 *   BENCH_FIXTURES="node_modules=/abs/path" node tests/ci/compressionBenchmark.ts
 *
 * Environment: BENCH_FIXTURES (required; comma-separated `name=/abs/path` pairs), BENCH_LEVELS
 * (default 1,2,3,5,9), BENCH_REPEATS (default 2; the report shows the fastest of N).
 * Writes compression-results.json and compression-results.md into BENCH_OUT (default the
 * workspace), and appends the tables to GITHUB_STEP_SUMMARY when set.
 */
import { buildCreateCommands, buildExtractCommands, findTar } from '../../src/archive/tar.ts';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MiB = 1024 * 1024;

const env = (name: string, fallback = ''): string => process.env[name] ?? fallback;
const repeats = Math.max(1, Number(env('BENCH_REPEATS', '2')));
const levels = env('BENCH_LEVELS', '1,2,3,5,9')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v !== '')
  .map(Number);
const workspace = env('GITHUB_WORKSPACE', process.cwd());
const outDir = env('BENCH_OUT', workspace);

interface Fixture {
  name: string;
  dir: string;
}

function parseFixtures(): Fixture[] {
  const raw = env('BENCH_FIXTURES');
  if (raw === '') {
    throw new Error('BENCH_FIXTURES is required, e.g. "node_modules=/abs/path"');
  }
  return raw.split(',').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new Error(`BENCH_FIXTURES entry "${pair}" is not in "name=/abs/path" form`);
    }
    const name = pair.slice(0, eq).trim();
    const dir = pair.slice(eq + 1).trim();
    if (name === '' || dir === '') {
      throw new Error(`BENCH_FIXTURES entry "${pair}" is not in "name=/abs/path" form`);
    }
    if (!fs.existsSync(dir)) {
      throw new Error(`Fixture "${name}" points at "${dir}", which does not exist`);
    }
    return { name, dir };
  });
}

interface Sample {
  fixture: string;
  level: number;
  archiveBytes: number;
  inputBytes: number;
  compressMs: number[];
  extractMs: number[];
}

/** Sum of file sizes under a directory, for the compression ratio. */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function runCommands(commands: { tool: string; args: string[] }[]): number {
  const start = Date.now();
  for (const command of commands) {
    const result = spawnSync(command.tool, command.args, { encoding: 'utf8', maxBuffer: 64 * MiB });
    if (result.status !== 0) {
      throw new Error(
        `${command.tool} exited with ${result.status}\n${result.stdout}\n${result.stderr}`
      );
    }
  }
  return Date.now() - start;
}

async function benchmarkFixture(fixture: Fixture): Promise<Sample[]> {
  const tar = await findTar();
  const inputBytes = directorySize(fixture.dir);
  const fixtureWorkspace = path.dirname(fixture.dir);
  const entry = path.basename(fixture.dir);
  const samples: Sample[] = [];

  for (const level of levels) {
    const sample: Sample = {
      fixture: fixture.name,
      level,
      archiveBytes: 0,
      inputBytes,
      compressMs: [],
      extractMs: [],
    };
    for (let i = 0; i < repeats; i++) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compression-bench-'));
      const manifestPath = path.join(tempDir, 'manifest.txt');
      fs.writeFileSync(manifestPath, `${entry}\n`);
      const archivePath = path.join(tempDir, 'cache.tar.zst');
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        const createCommands = buildCreateCommands({
          tar,
          platform: process.platform,
          compression: 'zstd',
          archivePath,
          workspace: fixtureWorkspace,
          tempDir,
          manifestPath,
          level,
        });
        const compressMs = runCommands(createCommands);
        sample.archiveBytes = fs.statSync(archivePath).size;
        sample.compressMs.push(compressMs);

        const extractCommands = buildExtractCommands({
          tar,
          platform: process.platform,
          compression: 'zstd',
          archivePath,
          workspace: extractDir,
          tempDir,
        });
        const extractMs = runCommands(extractCommands);
        sample.extractMs.push(extractMs);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
    samples.push(sample);
    console.log(
      `${fixture.name.padEnd(20)} level ${String(level).padEnd(2)} ` +
        `${(sample.archiveBytes / MiB).toFixed(1)} MiB, ` +
        `compress ${(Math.min(...sample.compressMs) / 1000).toFixed(1)} s, ` +
        `extract ${(Math.min(...sample.extractMs) / 1000).toFixed(1)} s`
    );
  }
  return samples;
}

async function main(): Promise<void> {
  const fixtures = parseFixtures();
  const runner = `${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, node ${process.version}`;
  console.log(`Runner: ${runner}. ${repeats} repeat(s) per level; the table shows the fastest.`);

  const lines: string[] = [];
  lines.push(`### Compression level benchmark, fastest of ${repeats}`);
  lines.push('');
  lines.push(`Runner: ${runner}.`);
  lines.push('');
  if (os.cpus().length > 4) {
    const warning =
      `\`zstd -T0\` scales with cores; this runner has ${os.cpus().length} CPUs, so compress ` +
      'times here will understate compress time on a smaller hosted runner.';
    console.log(`::warning::${warning}`);
    lines.push(`> **Warning:** ${warning}`);
    lines.push('');
  }

  const allSamples: Sample[] = [];
  for (const fixture of fixtures) {
    const samples = await benchmarkFixture(fixture);
    allSamples.push(...samples);
    const inputMb = (samples[0].inputBytes / MiB).toFixed(1);
    lines.push(`#### ${fixture.name} (${inputMb} MiB uncompressed)`);
    lines.push('');
    lines.push('| Level | Archive | Ratio | Compress | Extract |');
    lines.push('| ---: | ---: | ---: | ---: | ---: |');
    for (const sample of samples) {
      const archiveMb = (sample.archiveBytes / MiB).toFixed(1);
      const ratio = (sample.inputBytes / sample.archiveBytes).toFixed(2);
      const compress = (Math.min(...sample.compressMs) / 1000).toFixed(1);
      const extract = (Math.min(...sample.extractMs) / 1000).toFixed(1);
      lines.push(
        `| ${sample.level} | ${archiveMb} MiB | ${ratio}x | ${compress} s | ${extract} s |`
      );
    }
    lines.push('');
  }

  const markdown = lines.join('\n');
  console.log(`\n${markdown}\n`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'compression-results.md'), `${markdown}\n`);
  fs.writeFileSync(
    path.join(outDir, 'compression-results.json'),
    JSON.stringify({ repeats, levels, runner, samples: allSamples }, null, 2)
  );
  if (env('GITHUB_STEP_SUMMARY') !== '') {
    fs.appendFileSync(env('GITHUB_STEP_SUMMARY'), `${markdown}\n\n`);
  }
}

await main();
