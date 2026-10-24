import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards the rule that SITE_ORIGIN is for URLs this site serves, and that
 * everything else belongs to somebody else's namespace.
 *
 * Two failures it exists to catch:
 *   1. a hardcoded hostname outside the definition file, which would survive a
 *      change to SITE_ORIGIN and keep advertising the old host;
 *   2. emitted output pointing at a host nobody considered, which reads the
 *      same way to a visitor as a stale hostname does.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFINITION = path.join('docs', '.vitepress', 'site.mjs');
const HOSTNAME = 'xsavikx.github.io';
const DIST = path.join(REPO, 'docs', '.vitepress', 'dist');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'cache',
  'coverage',
  '.vitepress-cache',
]);
const SOURCE_EXT = /\.(mjs|js|ts|json|md|txt|html|css|xml|yml|yaml)$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (SOURCE_EXT.test(entry)) acc.push(full);
  }
  return acc;
}

describe('site origin', () => {
  it('is hardcoded only in the definition file', () => {
    const offenders: string[] = [];
    for (const file of walk(REPO)) {
      const rel = path.relative(REPO, file);
      // README is repo content, not emitted output, and is updated by hand
      // during a hostname change — see the note in site.mjs.
      if (rel === DEFINITION || rel === 'README.md' || rel.startsWith('tests' + path.sep)) continue;
      const text = readFileSync(file, 'utf8');
      if (!text.includes(HOSTNAME)) continue;
      text.split('\n').forEach((line, i) => {
        if (line.includes(HOSTNAME)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the templates free of it, since public/ used to hide them', () => {
    const dir = path.join(REPO, 'docs', '.vitepress', 'templates');
    for (const f of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, f), 'utf8')).not.toContain(HOSTNAME);
    }
  });
});

/**
 * These run against a real build. Skipped rather than failed when dist/ is
 * absent, so `npm test` on a clean checkout does not require a docs build —
 * but they run in CI, where docs are built.
 */
const describeBuilt = existsSync(DIST) ? describe : describe.skip;

describeBuilt('built output', () => {
  /**
   * Read the constants as text rather than importing: the definition is ESM
   * that Jest's transform will not load, and reading the literal asserts what
   * actually ships rather than what a transform produced.
   */
  function siteUrl(): { origin: string; url: string } {
    const src = readFileSync(path.join(REPO, DEFINITION), 'utf8');
    const origin = src.match(/export const SITE_ORIGIN = '([^']+)'/)?.[1];
    const base = src.match(/export const SITE_BASE = '([^']+)'/)?.[1];
    if (!origin || !base) throw new Error(`SITE_ORIGIN/SITE_BASE not found in ${DEFINITION}`);
    return { origin, url: `${origin}${base}` };
  }

  it('points every sitemap entry at our own site', () => {
    const { url } = siteUrl();
    const xml = readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    expect(locs.filter((l) => !l.startsWith(url))).toEqual([]);
  });

  it('points every canonical at our own site', () => {
    const { origin } = siteUrl();
    const offenders: string[] = [];
    for (const file of walk(DIST)) {
      if (!file.endsWith('.html')) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(
        /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/g
      )) {
        if (!m[1].startsWith(origin)) offenders.push(`${path.relative(DIST, file)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('generates the three files that used to be copied verbatim', () => {
    const { url } = siteUrl();
    // If these were still copied from public/, they would not contain the
    // current SITE_URL after a hostname change - they would contain the old one.
    for (const file of ['llms.txt', 'llms-full.txt', 'robots.txt']) {
      expect(readFileSync(path.join(DIST, file), 'utf8')).toContain(url);
    }
    expect(readFileSync(path.join(DIST, 'robots.txt'), 'utf8')).toContain(
      `Sitemap: ${url}sitemap.xml`
    );
  });
});
