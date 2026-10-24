// Stages the npm package of the cloud-cache CLI in build/npm. Run `npm run build:cli` first. The
// package has the bundle, a package.json with no dependencies, a README, and the LICENSE.
// The README template takes the docs URL from docs/.vitepress/site.mjs, as the docs templates do.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_URL } from '../docs/.vitepress/site.mjs';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build', 'npm');
const bundle = join(root, 'build', 'cli', 'cloud-cache.mjs');

type Manifest = {
  version: string;
  license: string;
  repository: unknown;
  author: unknown;
  keywords: string[];
};
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = {
  name: 'cloud-cache-action',
  version: pkg.version,
  description: 'CLI that restores and saves build caches in S3-compatible storage',
  type: 'module',
  bin: { 'cloud-cache': 'cloud-cache.mjs' },
  engines: { node: '>=24' },
  license: pkg.license,
  author: pkg.author,
  repository: pkg.repository,
  keywords: pkg.keywords,
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(bundle, join(out, 'cloud-cache.mjs'));
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
const readme = readFileSync(join(root, 'scripts', 'cliReadme.md'), 'utf8');
writeFileSync(join(out, 'README.md'), readme.replaceAll('{{SITE_URL}}', SITE_URL));
