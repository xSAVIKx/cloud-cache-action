import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitepress';
import {
  buildLlmsFull,
  buildLlmsIndex,
  pageUrl,
  releaseDate,
  sidebarPages,
} from '../../scripts/llmsText.ts';
import { SITE_ORIGIN, SITE_URL } from './site.mjs';

const SITE_TITLE = 'Cloud Cache Action';
const AUTHOR = { name: 'Yurii Serhiichuk', url: 'https://serhiichuk.dev' };
const REPO_URL = 'https://github.com/xSAVIKx/cloud-cache-action';
const DOCS_DIR = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(DOCS_DIR, '..');
const { version: VERSION } = JSON.parse(readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
const OG_IMAGE = `${SITE_URL}og-image.png`;

/**
 * Gives the time of the last commit that changed a repository file, in milliseconds.
 * docs/changelog.md only includes CHANGELOG.md, so the git time of docs/changelog.md is not
 * the time of the newest release.
 */
function gitTime(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%at', '--', file], {
      cwd: REPO_DIR,
      encoding: 'utf8',
    }).trim();
    return out ? Number(out) * 1000 : undefined;
  } catch {
    return undefined;
  }
}
const CHANGELOG_TIME = gitTime('CHANGELOG.md');

/** Gives the plain text of a heading: the text and code tokens, without link syntax. */
function headingText(tokens) {
  return tokens
    .filter((token) => token.type === 'text' || token.type === 'code_inline')
    .map((token) => token.content)
    .join('');
}

/**
 * Adds the permalink anchor to a heading, as the VitePress default does. The default puts
 * the raw Markdown of the heading in the aria-label, so a changelog heading that is a link
 * gave a label with the URL in it. This label has the plain text only.
 */
function permalink(slug, _options, state, index) {
  const title = headingText(state.tokens[index + 1].children);
  const space = new state.Token('text', '', 0);
  space.content = ' ';
  const open = new state.Token('link_open', 'a', 1);
  open.attrs = [
    ['class', 'header-anchor'],
    ['href', `#${slug}`],
    ['aria-label', `Permalink to "${title}"`],
  ];
  const symbol = new state.Token('html_inline', '', 0);
  symbol.content = '&ZeroWidthSpace;';
  symbol.meta = { isPermalinkSymbol: true };
  const close = new state.Token('link_close', 'a', -1);
  state.tokens[index + 1].children.push(space, open, symbol, close);
}

/** Makes JSON safe to put in a script element. */
function jsonLd(data) {
  return JSON.stringify(data).replaceAll('<', '\\u003c');
}

/**
 * Gives the structured data of a page. The home page describes the software. A sidebar page
 * gets a breadcrumb trail: the home page, the first page of its sidebar group, and the page.
 */
function structuredData(relativePath, title, description, sidebar) {
  if (relativePath === 'index.md') {
    return {
      '@context': 'https://schema.org',
      '@type': 'SoftwareSourceCode',
      name: SITE_TITLE,
      description,
      url: SITE_URL,
      codeRepository: REPO_URL,
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js 24',
      license: 'https://opensource.org/licenses/MIT',
      version: VERSION,
      author: { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url },
    };
  }
  const pages = sidebarPages(sidebar);
  const page = pages.find((item) => item.file === relativePath);
  if (!page) return undefined;
  const first = pages.find((item) => item.group === page.group);
  const trail = [{ name: SITE_TITLE, item: SITE_URL }];
  if (page.group && first && first.file !== page.file)
    trail.push({ name: page.group, item: pageUrl(SITE_URL, first.file) });
  trail.push({ name: title, item: pageUrl(SITE_URL, page.file) });
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((entry, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: entry.name,
      item: entry.item,
    })),
  };
}

export default defineConfig({
  title: SITE_TITLE,
  description:
    'Fast, flexible GitHub Action caching to any S3-compatible storage with 1:1 actions/cache parity',
  base: '/cloud-cache-action/',
  sitemap: {
    hostname: SITE_URL,
    transformItems(items) {
      return items
        .filter((item) => item.url !== '404.html')
        .map((item) =>
          item.url === 'changelog.html' && CHANGELOG_TIME
            ? { ...item, lastmod: CHANGELOG_TIME }
            : item
        );
    },
  },
  lastUpdated: true,
  markdown: {
    // The github-light theme gives YAML keys, numbers and comments less than 4.5:1 contrast.
    theme: { light: 'github-light-high-contrast', dark: 'github-dark' },
    anchor: { permalink },
  },
  transformPageData(pageData) {
    if (pageData.relativePath === 'changelog.md' && CHANGELOG_TIME) {
      return { lastUpdated: CHANGELOG_TIME };
    }
  },
  transformHtml(code) {
    return code.replace('class="VPContent is-home"', 'role="main" class="VPContent is-home"');
  },
  /**
   * Adds the canonical URL, the social tags and the structured data of each page. The
   * canonical URL is the .html form, because the sitemap, llms.txt and the README use it.
   */
  transformHead({ page, pageData, siteData, title, description }) {
    const ogImage = [
      ['meta', { property: 'og:image', content: OG_IMAGE }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: `${SITE_TITLE} logo and tagline` }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ];
    if (page === '404.md' || pageData.isNotFound) {
      return [['meta', { name: 'robots', content: 'noindex' }], ...ogImage];
    }
    const url = pageUrl(SITE_URL, pageData.relativePath);
    const head = [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: SITE_TITLE }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: url }],
      ...ogImage,
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
    ];
    const data = structuredData(
      pageData.relativePath,
      pageData.title || title,
      description,
      siteData.themeConfig.sidebar
    );
    if (data) head.push(['script', { type: 'application/ld+json' }, jsonLd(data)]);
    return head;
  },
  /**
   * llms.txt, llms-full.txt and robots.txt carry absolute URLs, so they are
   * generated from templates rather than copied. They used to live in public/,
   * which VitePress copies verbatim — meaning they would have survived a change
   * to SITE_ORIGIN untouched and kept advertising the old host while every
   * other emitted file moved. Copied assets are exactly where that hides.
   *
   * The page lists of llms.txt and the pages of llms-full.txt come from the sidebar, so a
   * new sidebar page is in both files without a change here.
   */
  buildEnd(siteConfig) {
    const templates = path.join(import.meta.dirname, 'templates');
    const changelog = readFileSync(path.join(REPO_DIR, 'CHANGELOG.md'), 'utf8');
    const release = { version: VERSION, date: releaseDate(changelog, VERSION) };
    const source = {
      docsDir: siteConfig.srcDir,
      repoDir: REPO_DIR,
      siteUrl: SITE_URL,
      pages: sidebarPages(siteConfig.site.themeConfig.sidebar),
    };
    const latest = `Latest release: v${release.version}${release.date ? ` (${release.date})` : ''}`;
    const fill = (text) =>
      text
        .replaceAll('{{SITE_URL}}', SITE_URL)
        .replaceAll('{{SITE_ORIGIN}}', SITE_ORIGIN)
        .replaceAll('{{LATEST_RELEASE}}', latest);
    const read = (file) => readFileSync(path.join(templates, file), 'utf8');
    const files = {
      'llms.txt': buildLlmsIndex(source, fill(read('llms.txt')), release),
      'llms-full.txt': buildLlmsFull(source, fill(read('llms-full.txt'))),
      'robots.txt': fill(read('robots.txt')),
    };
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(path.join(siteConfig.outDir, file), body);
    }
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/cloud-cache-action/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/cloud-cache-action/favicon.ico' }],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/cloud-cache-action/favicon-32x32.png',
      },
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/cloud-cache-action/favicon-16x16.png',
      },
    ],
    [
      'link',
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/cloud-cache-action/apple-touch-icon.png',
      },
    ],
    ['link', { rel: 'manifest', href: '/cloud-cache-action/site.webmanifest' }],
    ['meta', { name: 'theme-color', content: '#0ea5e9' }],
    ['meta', { name: 'author', content: AUTHOR.name }],
    [
      'meta',
      { name: 'google-site-verification', content: 'sMLPKoYMB5EoPQiOfUJ51P7xLG55OXBKV9PTEvp2HPw' },
    ],
    ['link', { rel: 'describedby', href: `${SITE_URL}llms.txt` }],
  ],
  themeConfig: {
    // The site name is next to the logo, so the logo is decorative.
    logo: { src: '/logo.svg', alt: '', width: 24, height: 24 },
    search: { provider: 'local' },
    lastUpdated: { formatOptions: { dateStyle: 'medium' } },
    editLink: {
      pattern: `${REPO_URL}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/guide/reference' },
      { text: 'Providers', link: '/providers/' },
      { text: 'Changelog', link: '/changelog' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Cache Presets', link: '/guide/presets' },
          { text: 'Migrate from actions/cache', link: '/guide/migration' },
          { text: 'Upgrading', link: '/guide/upgrading' },
          { text: 'FAQ', link: '/guide/faq' },
        ],
      },
      {
        text: 'Features',
        items: [
          { text: 'Dual Caching', link: '/guide/dual-caching' },
          { text: 'S3 Key Templating', link: '/guide/s3-key-patterns' },
          { text: 'Pruning Caches', link: '/guide/pruning' },
          { text: 'Inspecting Lookups', link: '/guide/inspecting' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Security', link: '/guide/security' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Benchmarks', link: '/guide/benchmarks' },
        ],
      },
      {
        text: 'Other CI Systems',
        items: [
          { text: 'The cloud-cache CLI', link: '/guide/cli' },
          { text: 'Bitbucket Pipelines', link: '/guide/bitbucket' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Inputs and Outputs', link: '/guide/reference' },
          { text: 'How Caches Are Stored', link: '/guide/storage' },
          { text: 'Comparison', link: '/guide/comparison' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
      {
        text: 'Storage Providers',
        items: [
          { text: 'Overview', link: '/providers/' },
          { text: 'AWS S3', link: '/providers/aws-s3' },
          { text: 'Cloudflare R2', link: '/providers/cloudflare-r2' },
          { text: 'Google Cloud Storage (GCS)', link: '/providers/google-cloud-storage' },
          { text: 'Backblaze B2', link: '/providers/backblaze-b2' },
          { text: 'Fastly Object Storage', link: '/providers/fastly-storage' },
          { text: 'Garage', link: '/providers/garage' },
          { text: 'SeaweedFS', link: '/providers/seaweedfs' },
          { text: 'MinIO', link: '/providers/minio' },
          { text: 'RustFS', link: '/providers/rustfs' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: REPO_URL }],
    footer: {
      message: `Released under the <a href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>.`,
      copyright: `Created by <a href="${AUTHOR.url}" target="_blank" rel="author noopener">${AUTHOR.name}</a>`,
    },
  },
});
