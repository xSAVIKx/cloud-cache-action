// Bundles the cloud-cache CLI (src/cli.ts) into one ESM file, build/cli/cloud-cache.mjs.
// ncc cannot do this: it emits extra chunk files and has no define option. esbuild injects the
// package version as `__CLI_VERSION__` and adds a shebang and a `require` shim for CommonJS
// dependencies. A build gives the same bytes each time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};

const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);',
].join('\n');

await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: join(root, 'build', 'cli', 'cloud-cache.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: { __CLI_VERSION__: JSON.stringify(version) },
  banner: { js: banner },
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});
