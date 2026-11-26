<script setup>
// The order in which a restore looks for a cache. The numbered list next to it on the page
// says the same thing, so a reader without the image loses nothing.
const refs = ['The current ref', 'The pull request base branch', 'The default branch'];
const steps = [
  'The exact key',
  'The newest object whose key starts with key',
  'The newest object for each restore-keys entry, in order',
];
const frameHeight = 128;
const top = 78;
</script>

<template>
  <figure class="restore-lookup">
    <svg
      viewBox="0 0 480 542"
      role="img"
      aria-labelledby="restore-lookup-title restore-lookup-desc"
    >
      <title id="restore-lookup-title">How a restore finds a cache</title>
      <desc id="restore-lookup-desc">
        For the current ref, then the pull request base branch, then the default branch, the
        restore tries the exact key, then the newest object whose key starts with the key, then
        each restore-keys entry. The first match is downloaded, verified and extracted. When no
        ref has a match, the result is a cache miss.
      </desc>
      <defs>
        <marker
          id="restore-lookup-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" class="arrow-head" />
        </marker>
      </defs>

      <rect x="10" y="4" width="460" height="56" rx="8" class="box accent" />
      <text x="240" y="26" class="label strong" text-anchor="middle">Restore with key and restore-keys</text>
      <text x="240" y="47" class="label muted" text-anchor="middle">The first match wins: download, verify sha256, extract</text>
      <line x1="240" y1="60" x2="240" y2="76" class="arrow" marker-end="url(#restore-lookup-arrow)" />

      <g v-for="(name, i) in refs" :key="name" :transform="`translate(0, ${top + i * frameHeight})`">
        <rect x="10" y="0" width="460" height="104" rx="10" class="frame" />
        <text x="24" y="22" class="label strong">{{ i + 1 }}. {{ name }}</text>
        <text v-for="(step, j) in steps" :key="step" x="40" :y="46 + j * 22" class="label">
          {{ String.fromCharCode(97 + j) }}. {{ step }}
        </text>
        <line
          x1="240"
          y1="104"
          x2="240"
          :y2="frameHeight - 2"
          class="arrow"
          marker-end="url(#restore-lookup-arrow)"
        />
        <text x="250" y="119" class="label muted">{{ i < 2 ? 'no match: next ref' : 'no match' }}</text>
      </g>

      <rect x="10" y="464" width="460" height="40" rx="8" class="box miss" />
      <text x="240" y="489" class="label" text-anchor="middle">Cache miss: the job runs without a cache</text>
      <text x="240" y="530" class="label muted" text-anchor="middle">Only objects with the same version and archive format count</text>
    </svg>
  </figure>
</template>

<style scoped>
.restore-lookup {
  margin: 24px 0;
}
.restore-lookup svg {
  display: block;
  width: 100%;
  max-width: 560px;
  height: auto;
  margin: 0 auto;
}
.label {
  fill: var(--vp-c-text-1);
  font-family: var(--vp-font-family-base);
  font-size: 15px;
}
.strong {
  font-weight: 600;
}
.muted {
  fill: var(--vp-c-text-2);
  font-size: 13px;
}
.frame {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
}
.box {
  stroke-width: 1.5;
}
.accent {
  fill: var(--vp-c-brand-soft);
  stroke: var(--vp-c-brand-1);
}
.miss {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-text-3);
  stroke-dasharray: 5 4;
}
.arrow {
  stroke: var(--vp-c-text-2);
  stroke-width: 1.5;
}
.arrow-head {
  fill: var(--vp-c-text-2);
}
</style>
