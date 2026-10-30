// Builds llms.txt and llms-full.txt from the Markdown sources in the order of the sidebar.
// docs/.vitepress/config.mjs calls these functions in buildEnd. A page that is added to the
// sidebar is added to both files on the next build. tests/unit/llmsText.test.ts runs the same
// functions on the source tree without a docs build.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** The repository files that a `<<<` code include points to are linked here. */
export const REPO_BLOB_URL = 'https://github.com/xSAVIKx/cloud-cache-action/blob/main/';

/** One item of the VitePress `themeConfig.sidebar` array. */
export interface SidebarItem {
  text?: string;
  link?: string;
  items?: SidebarItem[];
}

/** One page of the sidebar. `file` is relative to the docs directory, for example `guide/cli.md`. */
export interface SidebarPage {
  group: string;
  text: string;
  link: string;
  file: string;
}

/** The input of the two generators. */
export interface LlmsSource {
  /** The VitePress source directory (`docs`). */
  docsDir: string;
  /** The repository root. Code includes are linked relative to it. */
  repoDir: string;
  /** The absolute base URL of the site, with a trailing slash. */
  siteUrl: string;
  /** The pages in sidebar order. */
  pages: SidebarPage[];
}

/** Changes a sidebar link such as `/guide/cli` or `/providers/` to a file such as `guide/cli.md`. */
export function linkToFile(link: string): string {
  let file = link.replace(/[?#].*$/, '').replace(/^\//, '');
  if (file === '' || file.endsWith('/')) file += 'index';
  return file.replace(/\.(html|md)$/, '') + '.md';
}

/** Gives the published URL of a page. It is the `.html` form, and `index.md` gives its folder. */
export function pageUrl(siteUrl: string, file: string): string {
  return siteUrl + file.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
}

/** Gives every page of the sidebar once, in sidebar order, with its top-level group. */
export function sidebarPages(sidebar: SidebarItem[]): SidebarPage[] {
  const pages: SidebarPage[] = [];
  const seen = new Set<string>();
  const visit = (item: SidebarItem, group: string): void => {
    if (item.link && !/^[a-z]+:/i.test(item.link)) {
      const file = linkToFile(item.link);
      if (!seen.has(file)) {
        seen.add(file);
        pages.push({ group, text: item.text ?? file, link: item.link, file });
      }
    }
    for (const child of item.items ?? []) visit(child, group);
  };
  for (const top of sidebar) visit(top, top.text ?? '');
  return pages;
}

/** Splits the YAML front matter from the Markdown body. */
export function splitFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!match) return { data: {}, body: src };
  const data: unknown = parseYaml(match[1]);
  return {
    data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
    body: src.slice(match[0].length),
  };
}

/** Removes the Markdown link syntax and the emphasis marks from one line of text. */
function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[_*]([^_*]+)[_*](?=[\s.,:;!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Gives the `description` front matter of a page. When the page has none, it gives the first
 * paragraph after the h1, as plain text.
 */
export function pageDescription(src: string): string {
  const { data, body } = splitFrontmatter(src);
  if (typeof data.description === 'string' && data.description.trim()) {
    return data.description.trim();
  }
  const lines = body.split(/\r?\n/);
  let i = lines.findIndex((line) => /^#\s/.test(line));
  i = i < 0 ? 0 : i + 1;
  const paragraph: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    if (!paragraph.length && /^(#|```|<|\||:::|>|<<<|-{3,}$)/.test(line)) continue;
    paragraph.push(line);
  }
  return shortSummary(plainText(paragraph.join(' ')));
}

/**
 * Keeps the first sentences of a paragraph, up to about 200 characters. A paragraph that
 * ends with a colon introduces a list or a code block, so the colon becomes a full stop.
 */
function shortSummary(text: string): string {
  const sentences = text.match(/.+?(?:[.!?]+(?=\s|$)|$)/g) ?? [text];
  let summary = '';
  for (const sentence of sentences) {
    if (summary && summary.length + sentence.length > 200) break;
    summary += sentence;
  }
  return summary.trim().replace(/:$/, '.');
}

/** Gives the title of a page: the `title` front matter, or the text of the h1. */
export function pageTitle(src: string): string | undefined {
  const { data, body } = splitFrontmatter(src);
  if (typeof data.title === 'string') return data.title;
  const h1 = /^#\s+(.+)$/m.exec(body);
  return h1 ? plainText(h1[1]) : undefined;
}

/** Holds the context of one Markdown file while its text is changed. */
interface FileContext {
  source: LlmsSource;
  /** The directory that relative links resolve against, relative to the docs directory. */
  linkDir: string;
  /** The absolute directory that include paths resolve against. */
  includeDir: string;
}

/** Changes a relative or site-root link target to an absolute URL. Other targets do not change. */
function absoluteTarget(target: string, ctx: FileContext): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) return target;
  const [, rawPath, hash = ''] = /^([^#]*)(#.*)?$/.exec(target) ?? [];
  if (!rawPath) return target;
  const { docsDir, repoDir, siteUrl } = ctx.source;
  const rel = rawPath.startsWith('/')
    ? path.posix.normalize(rawPath.slice(1))
    : path.posix.normalize(path.posix.join(ctx.linkDir, rawPath));
  if (rel.startsWith('../')) {
    // A link out of the docs directory points to a repository file.
    const repoRel = path.relative(repoDir, path.resolve(docsDir, rel)).split(path.sep).join('/');
    return repoRel.startsWith('..') ? target : REPO_BLOB_URL + repoRel + hash;
  }
  if (/\.md$/.test(rel)) return pageUrl(siteUrl, rel) + hash;
  if (rel.endsWith('/') || rel === '.')
    return pageUrl(siteUrl, `${rel === '.' ? '' : rel}index.md`);
  if (!path.posix.extname(rel) && existsSync(path.join(docsDir, `${rel}.md`))) {
    return pageUrl(siteUrl, `${rel}.md`) + hash;
  }
  if (/\.html$/.test(rel)) return siteUrl + rel + hash;
  // A file in public/ is served at the same path.
  return siteUrl + rel + hash;
}

/**
 * Matches an inline link or image, or an inline code span. A link text can hold code, for
 * example [`prune`](./pruning.md). A code span is matched only so that it does not change.
 */
const LINK_OR_CODE = /(!?\[(?:[^\]`]|`[^`]*`)*\]\()(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\))|`[^`]*`/g;

/** Changes the targets of the inline Markdown links and images in a block of prose. */
function rewriteLinks(line: string, ctx: FileContext): string {
  return line.replace(LINK_OR_CODE, (match, open?: string, target?: string, close?: string) =>
    open && target && close
      ? open + absoluteTarget(target.replace(/^<|>$/g, ''), ctx) + close
      : match
  );
}

/** Gives a link to a repository file, for a `<<<` code include or an include that fails. */
function repoLink(absFile: string, ctx: FileContext): string {
  const repoRel = path.relative(ctx.source.repoDir, absFile).split(path.sep).join('/');
  return `[${repoRel}](${REPO_BLOB_URL}${repoRel})`;
}

/**
 * Changes one Markdown file to the text of llms-full.txt: no front matter, Markdown includes
 * resolved, code includes changed to a link, Vue components removed, and relative links made
 * absolute.
 */
function renderMarkdown(src: string, ctx: FileContext, depth: number): string {
  const { body } = splitFrontmatter(src);
  const out: string[] = [];
  // Prose lines wait here until a block ends, because a link text can span two lines.
  const prose: string[] = [];
  const flush = (): void => {
    if (prose.length) out.push(rewriteLinks(prose.join('\n'), ctx));
    prose.length = 0;
  };
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      out.push(line);
      continue;
    }

    const include = /^\s*<!--\s*@include:\s*([^\s]+?)\s*-->\s*$/.exec(line);
    if (include) {
      flush();
      const [, spec] = include;
      const target = spec.replace(/^@\//, '/');
      const file = target.startsWith('/')
        ? path.join(ctx.source.docsDir, target)
        : path.resolve(ctx.includeDir, target);
      // A line range, a region or a deep include falls back to a link.
      if (depth < 3 && existsSync(file) && !/[{#]/.test(spec)) {
        const nested: FileContext = { ...ctx, includeDir: path.dirname(file) };
        out.push(renderMarkdown(readFileSync(file, 'utf8'), nested, depth + 1).trim());
      } else {
        out.push(`Included file: ${repoLink(file.replace(/[{#].*$/, ''), ctx)}`);
      }
      continue;
    }

    // A diagram component has no text. The prose next to it says the same thing.
    if (/^\s*<[A-Z][A-Za-z]*\s*\/>\s*$/.test(line)) continue;

    const code = /^\s*<<<\s+(\S+)/.exec(line);
    if (code) {
      flush();
      const spec = code[1].replace(/\{[^}]*\}.*$/, '').replace(/#.*$/, '');
      const file = spec.startsWith('@/')
        ? path.join(ctx.source.docsDir, spec.slice(2))
        : path.resolve(ctx.includeDir, spec);
      out.push(`Source file: ${repoLink(file, ctx)}`);
      continue;
    }

    prose.push(line);
  }
  flush();
  return out.join('\n');
}

/** Gives the llms-full.txt text of one page of the docs directory. */
export function pageText(source: LlmsSource, file: string): string {
  const abs = path.join(source.docsDir, file);
  const dir = path.posix.dirname(file);
  const ctx: FileContext = {
    source,
    linkDir: dir === '.' ? '' : dir,
    includeDir: path.dirname(abs),
  };
  return renderMarkdown(readFileSync(abs, 'utf8'), ctx, 0).trim();
}

/** Adds the changelog after the sidebar pages when the sidebar does not list it. */
function withChangelog(pages: SidebarPage[]): SidebarPage[] {
  if (pages.some((page) => page.file === 'changelog.md')) return pages;
  return [...pages, { group: '', text: 'Changelog', link: '/changelog', file: 'changelog.md' }];
}

/** Builds llms-full.txt: the header, then every sidebar page and the changelog. */
export function buildLlmsFull(source: LlmsSource, header: string): string {
  const rule = `<!-- ${'='.repeat(76)} -->`;
  const sections = withChangelog(source.pages).map((page) =>
    [
      rule,
      `<!-- FILE: docs/${page.file} -->`,
      `<!-- URL: ${pageUrl(source.siteUrl, page.file)} -->`,
      rule,
      '',
      pageText(source, page.file),
    ].join('\n')
  );
  return `${header.trimEnd()}\n\n${sections.join('\n\n\n')}\n`;
}

/** Gives the version and the date of a release from CHANGELOG.md. */
export function releaseDate(changelog: string, version: string): string | undefined {
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^##\\s+\\[?v?${escaped}\\]?.*?(\\d{4}-\\d{2}-\\d{2})`, 'm');
  return heading.exec(changelog)?.[1];
}

/** Builds one Markdown list line for each page. */
function pageList(source: LlmsSource, pages: SidebarPage[]): string {
  return pages
    .map((page) => {
      const src = readFileSync(path.join(source.docsDir, page.file), 'utf8');
      const description = pageDescription(src);
      const line = `- [${page.text}](${pageUrl(source.siteUrl, page.file)})`;
      return description ? `${line}: ${description}` : line;
    })
    .join('\n');
}

/**
 * Builds llms.txt from its template. The template keeps the hand-written introduction and has
 * these placeholders: `{{LATEST_RELEASE}}`, `{{DOCUMENTATION}}` (every page that is not a
 * provider page) and `{{PROVIDERS}}` (every page under `providers/`).
 */
export function buildLlmsIndex(
  source: LlmsSource,
  template: string,
  release: { version: string; date?: string }
): string {
  const pages = withChangelog(source.pages);
  const providers = pages.filter((page) => page.file.startsWith('providers/'));
  const docs = pages.filter(
    (page) => !page.file.startsWith('providers/') && page.file !== 'index.md'
  );
  const latest = `Latest release: v${release.version}${release.date ? ` (${release.date})` : ''}`;
  return template
    .replaceAll('{{LATEST_RELEASE}}', latest)
    .replaceAll('{{DOCUMENTATION}}', pageList(source, docs))
    .replaceAll('{{PROVIDERS}}', pageList(source, providers));
}
