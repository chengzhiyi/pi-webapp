import { readFileSync } from 'node:fs';
import { defineConfigWithTheme, type DefaultTheme } from 'vitepress';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const topics = [
  ['getting-started', '安装与首次对话', 'Install & first conversation'],
  ['sessions', '会话与工作区', 'Sessions & workspaces'],
  ['conversation', '对话控制与附件', 'Controls & attachments'],
  ['workspace-tools', '文件、终端与 Git', 'Files, terminal & Git'],
  ['configuration', '模型、包与技能', 'Models, packages & skills'],
  ['updates', '升级与恢复', 'Updates & recovery'],
  ['desktop', '桌面测试版', 'Desktop test builds'],
  ['troubleshooting', '常见问题', 'Troubleshooting'],
  ['security', '安全与隐私', 'Security & privacy'],
  ['reference', '配置与版本参考', 'Configuration & versions'],
  ['resources', '开发与历史资料', 'Development & archives'],
];
const sidebar = (lang: 'zh' | 'en') => [{
  text: lang === 'zh' ? '用户指南' : 'User guide',
  items: [
    { text: lang === 'zh' ? '简介与方式选择' : 'Overview & entry points', link: `/${lang}/` },
    ...topics.map(([slug, zh, en]) => ({ text: lang === 'zh' ? zh : en, link: `/${lang}/${slug}` })),
  ],
}];

export default defineConfigWithTheme<DefaultTheme.Config & { sourceVersion: string }>({
  title: 'pi-webapp',
  description: 'Local Pi web and desktop user guide / 本地 Pi Web 与桌面使用指南',
  // Test a project subpath now; this does not enable or deploy GitHub Pages.
  base: '/pi-webapp/',
  // Existing engineering/operations/history Markdown stays in GitHub.
  // check-site.mjs additionally enforces the reviewed output-page allowlist.
  srcExclude: ['MAINTAINING.md', 'architecture.md', 'desktop.md', 'desktop-testing.md', 'sentry.md', 'sentry-triage.md', 'spec.md', 'web-plugins.md', 'prompt-delivery.md', 'decisions/**'],
  locales: {
    zh: {
      label: '简体中文', lang: 'zh-CN', link: '/zh/',
      themeConfig: {
        nav: [{ text: '用户指南', link: '/zh/' }], sidebar: sidebar('zh'),
        outline: { label: '本页内容' },
        sidebarMenuLabel: '目录',
        returnToTopLabel: '返回顶部',
        langMenuLabel: '切换语言',
        docFooter: { prev: '上一页', next: '下一页' },
        footer: { message: `开发版文档 · 源码清单 ${version} · 非已发布版本承诺`, copyright: 'MIT · pi-webapp' },
      },
    },
    en: {
      label: 'English', lang: 'en', link: '/en/',
      themeConfig: {
        nav: [{ text: 'User guide', link: '/en/' }], sidebar: sidebar('en'),
        footer: { message: `Development docs · source manifest ${version} · not a released-version guarantee`, copyright: 'MIT · pi-webapp' },
      },
    },
  },
  themeConfig: {
    sourceVersion: version,
    search: {
      provider: 'local',
      options: {
        // Index Latin words plus individual Han characters, so Chinese substring queries work.
        miniSearch: { options: { tokenize: (text: string) => text.toLowerCase().match(/[a-z0-9_]+|\p{Script=Han}|[^\s\p{P}\p{S}a-z0-9_\p{Script=Han}]+/gu) || [] } },
        locales: { zh: { translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' }, modal: { noResultsText: '没有找到结果', resetButtonTitle: '清除搜索', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } } } },
      },
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/chengzhiyi/pi-webapp' }],
  },
  cleanUrls: false,
  lastUpdated: false,
});
