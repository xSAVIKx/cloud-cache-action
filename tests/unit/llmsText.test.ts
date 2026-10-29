import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLlmsFull,
  buildLlmsIndex,
  type LlmsSource,
  linkToFile,
  pageDescription,
  pageUrl,
  releaseDate,
  type SidebarItem,
  sidebarPages,
} from '../../scripts/llmsText.js';

/**
 * Runs the llms.txt and llms-full.txt generators on the source tree, without a docs build.
 * The sidebar comes from docs/.vitepress/config.mjs, so a page added to the sidebar is
 * checked here without a change to this test.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(REPO, 'docs');
const SITE_URL = 'https://docs.example.test/cloud-cache-action/';

/** Jest does not load the ESM config, so a child Node process prints the sidebar. */
function loadSidebar(): SidebarItem[] {
  const script =
    "const c = (await import('./docs/.vitepress/config.mjs')).default;" +
    'process.stdout.write(JSON.stringify(c.themeConfig.sidebar));';
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return JSON.parse(out) as SidebarItem[];
}

const sidebar = loadSidebar();
const source: LlmsSource = {
  docsDir: DOCS,
  repoDir: REPO,
  siteUrl: SITE_URL,
  pages: sidebarPages(sidebar),
};
const full = buildLlmsFull(source, '# Header');

/** Removes the fenced code blocks, so the checks below look at the prose only. */
function withoutCode(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

describe('llms-full.txt', () => {
  it('has every sidebar page, in sidebar order', () => {
    expect(source.pages.length).toBeGreaterThan(10);
    let last = -1;
    for (const page of source.pages) {
      const at = full.indexOf(`<!-- FILE: docs/${page.file} -->`);
      expect({ page: page.file, found: at >= 0 }).toEqual({ page: page.file, found: true });
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('has the body of every sidebar page and the changelog', () => {
    const files = [...source.pages.map((page) => page.file), 'changelog.md'];
    for (const file of new Set(files)) {
      const body = readFileSync(path.join(DOCS, file), 'utf8');
      const h1 = /^#\s+(.+)$/m.exec(body.replace(/^---[\s\S]*?\n---\n/, ''))?.[1];
      if (h1) expect(full).toContain(`# ${h1}`);
    }
    // The changelog page only includes CHANGELOG.md, so its entries must be in the file.
    expect(full).toContain('## [1.9.0]');
  });

  it('strips front matter, resolves includes and makes links absolute', () => {
    const prose = withoutCode(full);
    expect(prose).not.toMatch(/^title:\s/m);
    expect(prose).not.toMatch(/^<<<\s/m);
    expect(prose).not.toContain('@include');
    expect(prose).not.toMatch(/\]\((?!https?:|mailto:|#)[^)]*\)/);
    expect(prose).toContain(`](${SITE_URL}guide/getting-started.html`);
    expect(prose).toContain('Source file: [action.yml](https://github.com/');
  });
});

describe('llms.txt', () => {
  const template = '{{LATEST_RELEASE}}\n\n## Docs\n\n{{DOCUMENTATION}}\n\n## P\n\n{{PROVIDERS}}\n';
  const index = buildLlmsIndex(source, template, { version: '9.9.9', date: '2030-01-02' });

  it('lists every sidebar page with a description', () => {
    for (const page of source.pages.filter((item) => item.file !== 'index.md')) {
      const line = `- [${page.text}](${pageUrl(SITE_URL, page.file)}): `;
      expect({ page: page.file, listed: index.includes(line) }).toEqual({
        page: page.file,
        listed: true,
      });
    }
    expect(index).toContain('Latest release: v9.9.9 (2030-01-02)');
  });

  it('puts the provider pages in the providers list only', () => {
    const [docs, providers] = index.split('## P');
    expect(docs).not.toContain('/providers/');
    expect(providers).toContain(`${SITE_URL}providers/aws-s3.html`);
  });
});

describe('helpers', () => {
  it('maps sidebar links to files and files to URLs', () => {
    expect(linkToFile('/guide/cli')).toBe('guide/cli.md');
    expect(linkToFile('/providers/')).toBe('providers/index.md');
    expect(linkToFile('/guide/cli.html#flags')).toBe('guide/cli.md');
    expect(pageUrl(SITE_URL, 'index.md')).toBe(SITE_URL);
    expect(pageUrl(SITE_URL, 'providers/index.md')).toBe(`${SITE_URL}providers/`);
    expect(pageUrl(SITE_URL, 'guide/cli.md')).toBe(`${SITE_URL}guide/cli.html`);
  });

  it('uses the description front matter, then the first paragraph', () => {
    expect(pageDescription('---\ndescription: From front matter.\n---\n# T\n\nBody.')).toBe(
      'From front matter.'
    );
    expect(pageDescription('# Title\n\nThe **first** [paragraph](./x.md)\nof text.\n\nNext.')).toBe(
      'The first paragraph of text.'
    );
  });

  it('reads the release date from both changelog heading formats', () => {
    const log = '## [1.10.1](https://x/compare) (2026-10-29)\n\n## [1.9.0] - 2026-10-24\n';
    expect(releaseDate(log, '1.10.1')).toBe('2026-10-29');
    expect(releaseDate(log, '1.9.0')).toBe('2026-10-24');
    expect(releaseDate(log, '1.0.0')).toBeUndefined();
  });
});
