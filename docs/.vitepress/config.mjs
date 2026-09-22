import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitepress';
import { SITE_URL } from './site.mjs';

export default defineConfig({
  title: 'Cloud Cache Action',
  description:
    'Fast, flexible GitHub Action caching to any S3-compatible storage with 1:1 actions/cache parity',
  base: '/cloud-cache-action/',
  sitemap: {
    hostname: SITE_URL,
  },
  lastUpdated: true,
  transformHtml(code) {
    return code.replace('class="VPContent is-home"', 'role="main" class="VPContent is-home"');
  },
  /**
   * llms.txt, llms-full.txt and robots.txt carry absolute URLs, so they are
   * generated from templates rather than copied. They used to live in public/,
   * which VitePress copies verbatim — meaning they would have survived a change
   * to SITE_ORIGIN untouched and kept advertising the old host while every
   * other emitted file moved. Copied assets are exactly where that hides.
   */
  buildEnd(siteConfig) {
    const templates = path.join(import.meta.dirname, 'templates');
    for (const file of ['llms.txt', 'llms-full.txt', 'robots.txt']) {
      const body = readFileSync(path.join(templates, file), 'utf8').replaceAll(
        '{{SITE_URL}}',
        SITE_URL
      );
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
    ['meta', { property: 'og:image', content: '/cloud-cache-action/android-chrome-512x512.png' }],
    [
      'meta',
      { name: 'google-site-verification', content: 'sMLPKoYMB5EoPQiOfUJ51P7xLG55OXBKV9PTEvp2HPw' },
    ],
    ['link', { rel: 'describedby', href: `${SITE_URL}llms.txt` }],
  ],
  themeConfig: {
    logo: { src: '/logo.svg', alt: 'Cloud Cache Action' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Dual Caching', link: '/guide/dual-caching' },
      { text: 'Providers', link: '/providers/aws-s3' },
      { text: 'Key Patterns', link: '/guide/s3-key-patterns' },
      { text: 'Pruning', link: '/guide/pruning' },
      { text: 'Inspecting', link: '/guide/inspecting' },
      { text: 'Performance', link: '/guide/performance' },
      { text: 'Migration', link: '/guide/migration' },
      { text: 'Changelog', link: '/changelog' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Dual Caching (S3 + GitHub)', link: '/guide/dual-caching' },
          { text: 'S3 Key Templating', link: '/guide/s3-key-patterns' },
          { text: 'Pruning Caches', link: '/guide/pruning' },
          { text: 'Inspecting Lookups', link: '/guide/inspecting' },
          { text: 'Performance', link: '/guide/performance' },
          { text: 'Migrating from actions/cache', link: '/guide/migration' },
        ],
      },
      {
        text: 'Storage Providers',
        items: [
          { text: 'AWS S3', link: '/providers/aws-s3' },
          { text: 'Cloudflare R2', link: '/providers/cloudflare-r2' },
          { text: 'Google Cloud Storage (GCS)', link: '/providers/google-cloud-storage' },
          { text: 'Backblaze B2', link: '/providers/backblaze-b2' },
          { text: 'Fastly Object Storage', link: '/providers/fastly-storage' },
          { text: 'Garage S3', link: '/providers/garage' },
          { text: 'SeaweedFS S3', link: '/providers/seaweedfs' },
          { text: 'MinIO S3', link: '/providers/minio' },
          { text: 'RustFS', link: '/providers/rustfs' },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Changelog', link: '/changelog' }],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/xSAVIKx/cloud-cache-action' }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Created by <a href="https://serhiichuk.dev" target="_blank">Yurii Serhiichuk</a>',
    },
  },
});
