<script setup>
import { withBase } from 'vitepress';

// The default 404 page shows a quote and one link. This page gives the main entry points.
const links = [
  { text: 'Home', link: '/' },
  { text: 'Getting Started', link: '/guide/getting-started.html' },
  { text: 'Inputs and Outputs', link: '/guide/reference.html' },
  { text: 'Migrating from actions/cache', link: '/guide/migration.html' },
  { text: 'Changelog', link: '/changelog.html' },
];
</script>

<template>
  <div class="not-found">
    <p class="code">404</p>
    <h1 class="title">Page not found</h1>
    <p class="text">
      This page is not on the site. It moved, or the link has an error. Use the search in the
      navigation bar, or open one of these pages:
    </p>
    <ul class="links">
      <li v-for="item in links" :key="item.link">
        <a :href="withBase(item.link)">{{ item.text }}</a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.not-found {
  max-width: 640px;
  margin: 0 auto;
  padding: 64px 24px 96px;
}

.code {
  font-size: 64px;
  font-weight: 600;
  line-height: 64px;
  color: var(--vp-c-text-2);
}

.title {
  margin-top: 16px;
  font-size: 24px;
  font-weight: 600;
  line-height: 32px;
}

.text {
  margin-top: 16px;
  line-height: 28px;
  color: var(--vp-c-text-1);
}

.links {
  margin-top: 16px;
  padding-left: 1.25rem;
  list-style: disc;
  line-height: 32px;
}

.links a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 2px;
  font-weight: 500;
}

.links a:hover {
  color: var(--vp-c-brand-2);
}
</style>
