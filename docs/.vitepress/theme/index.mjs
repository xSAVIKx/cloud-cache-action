// theme-without-fonts does not load Inter. The shared identity uses system fonts only.
import DefaultTheme from 'vitepress/theme-without-fonts';
import { h } from 'vue';
import DocFooter from './DocFooter.vue';
import NotFound from './NotFound.vue';
import RestoreLookup from './RestoreLookup.vue';
import './style.css';
// The shared neutrals and fonts. Load it after style.css. It does not set brand colours.
import './ys-vitepress.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('RestoreLookup', RestoreLookup);
  },
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-after': () => h(DocFooter),
      'not-found': () => h(NotFound),
    });
  },
};
