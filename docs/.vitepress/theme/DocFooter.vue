<template>
  <footer class="vp-doc-footer-attribution">
    <div class="footer-content">
      <p class="license-text">Released under the <a href="https://github.com/xSAVIKx/cloud-cache-action/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>.</p>
      <p class="author-text">
        Created by
        <a href="https://serhiichuk.dev" target="_blank" rel="author noopener">Yurii Serhiichuk</a>
      </p>
    </div>
  </footer>
</template>

<style scoped>
.vp-doc-footer-attribution {
  margin-top: 3rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--vp-c-divider);
  text-align: center;
  font-size: 14px;
  line-height: 24px;
  color: var(--vp-c-text-2);
}

.vp-doc-footer-attribution a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
  text-underline-offset: 2px;
  font-weight: 500;
  transition: color 0.25s;
}

.vp-doc-footer-attribution a:hover {
  color: var(--vp-c-brand-2);
}

.footer-content {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-items: center;
}

@media (min-width: 640px) {
  .footer-content {
    flex-direction: row;
    justify-content: center;
    gap: 1.5rem;
  }
}
</style>
