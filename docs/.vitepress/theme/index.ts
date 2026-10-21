import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import { defineComponent, h } from 'vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    setup() {
      const { lang, theme } = useData<{ sourceVersion: string }>();
      return () => h(DefaultTheme.Layout, null, {
        'doc-before': () => h('p', { class: 'docs-version', role: 'note' },
          lang.value.startsWith('zh')
            ? `开发版文档 · 源码清单 ${theme.value.sourceVersion} · 未核验线上发行`
            : `Development docs · source manifest ${theme.value.sourceVersion} · public release not verified`),
      });
    },
  }),
};
