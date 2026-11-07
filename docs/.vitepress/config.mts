import { defineConfig } from 'vitepress';

const repo = 'https://github.com/chengzhiyi/pi-webapp';
// The site is served from the root of its own domain. For the project URL
// (https://chengzhiyi.github.io/pi-webapp/) build with DOCS_BASE=/pi-webapp/.
const base = process.env.DOCS_BASE ?? '/';
const siteUrl = 'https://pi.emath.top';

// The English guide lives in docs/en/ and is published at the site root; the
// Chinese translation lives in docs/zh/ and is published under /zh/.
type Labels = Record<string, string>;
const sidebar = (prefix: string, t: Labels) => [
  {
    text: t.gettingStarted,
    items: [
      { text: t.introduction, link: `${prefix}/introduction` },
      { text: t.quickStart, link: `${prefix}/getting-started` },
      { text: t.desktop, link: `${prefix}/desktop` },
      { text: t.usePi, link: `${prefix}/use-from-pi` },
    ],
  },
  {
    text: t.using,
    items: [
      { text: t.conversation, link: `${prefix}/conversation` },
      { text: t.sessions, link: `${prefix}/sessions` },
      { text: t.tools, link: `${prefix}/workspace-tools` },
      { text: t.diagrams, link: `${prefix}/diagrams` },
    ],
  },
  {
    text: t.configuration,
    items: [
      { text: t.overview, link: `${prefix}/configuration` },
      { text: t.models, link: `${prefix}/models` },
      { text: t.extensions, link: `${prefix}/extensions` },
      { text: t.updates, link: `${prefix}/updates` },
    ],
  },
  { text: t.security, link: `${prefix}/security` },
  {
    text: t.help,
    items: [
      { text: t.troubleshooting, link: `${prefix}/troubleshooting` },
      { text: t.faq, link: `${prefix}/faq` },
    ],
  },
  {
    text: t.reference,
    items: [
      { text: t.cli, link: `${prefix}/reference/cli` },
      { text: t.env, link: `${prefix}/reference/environment` },
      { text: t.files, link: `${prefix}/reference/files` },
      { text: t.limits, link: `${prefix}/reference/limits` },
      { text: t.glossary, link: `${prefix}/reference/glossary` },
    ],
  },
  { text: t.changelog, link: `${prefix}/changelog` },
  { text: t.developers, link: `${prefix}/developers` },
];

const en: Labels = {
  gettingStarted: 'Getting started', introduction: 'Introduction', quickStart: 'Quick start', desktop: 'Desktop app',
  usePi: 'Use it from the Pi terminal', using: 'Using pi-webapp', conversation: 'Conversations',
  sessions: 'Sessions and workspaces', tools: 'Files, terminal and Git', diagrams: 'Diagrams with Excalidraw',
  configuration: 'Configuration', overview: 'Overview', models: 'Models and providers',
  extensions: 'Packages, skills and plugins', updates: 'Updates', security: 'Security and privacy', help: 'Help',
  troubleshooting: 'Troubleshooting', faq: 'FAQ', reference: 'Reference', cli: 'Command line',
  env: 'Environment variables', files: 'Files and directories', limits: 'Limits', glossary: 'Glossary',
  developers: 'Developers', changelog: 'Changelog',
};
const zh: Labels = {
  gettingStarted: '开始使用', introduction: '简介', quickStart: '快速开始', desktop: '桌面版',
  usePi: '在 Pi 终端里使用', using: '日常使用', conversation: '对话',
  sessions: '会话与工作区', tools: '文件、终端与 Git', diagrams: '用 Excalidraw 画图',
  configuration: '配置', overview: '概览', models: '模型与提供方',
  extensions: '包、技能与插件', updates: '更新', security: '安全与隐私', help: '帮助',
  troubleshooting: '排错', faq: '常见问题', reference: '参考',  cli: '命令行',
  env: '环境变量', files: '文件与目录', limits: '限制', glossary: '术语表',
  developers: '开发者', changelog: '更新日志',
};

export default defineConfig({
  title: 'pi-webapp',
  lang: 'en',
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: siteUrl },
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }]],

  // Publish docs/en/ at the site root. docs/zh/ is already at /zh/. Everything
  // else under docs/ is engineering material (design notes, release and CI
  // records) that stays on GitHub; the Developers page links to it.
  rewrites: { 'en/:rest*': ':rest*' },
  srcExclude: ['*.md', 'ci/**', 'decisions/**', 'evidence/**', 'tests/**', 'node_modules/**'],

  markdown: { image: { lazyLoading: true } },

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      description: 'User guide for pi-webapp: a browser and desktop workbench for the Pi coding agent.',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/introduction', activeMatch: '^/(?!reference/|troubleshooting|faq|developers|changelog)' },
          { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference/' },
          { text: 'Troubleshooting', link: '/troubleshooting', activeMatch: '^/(troubleshooting|faq)' },
          { text: 'Changelog', link: '/changelog' },
          { text: 'Developers', link: '/developers' },
        ],
        sidebar: sidebar('', en),
        editLink: { pattern: ({ filePath }) => `https://github.com/chengzhiyi/pi-webapp/edit/main/docs/${filePath}`, text: 'Edit this page on GitHub' },
        footer: {
          message: 'These pages describe the source in this repository. Check <strong>Pi Settings → General</strong> for the version you are running.',
          copyright: 'MIT licensed · pi-webapp',
        },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description: 'pi-webapp 使用指南：Pi 编程代理的浏览器与桌面工作台。',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh/introduction', activeMatch: '^/zh/(?!reference/|troubleshooting|faq|developers|changelog)' },
          { text: '参考', link: '/zh/reference/cli', activeMatch: '^/zh/reference/' },
          { text: '排错', link: '/zh/troubleshooting', activeMatch: '^/zh/(troubleshooting|faq)' },
          { text: '更新日志', link: '/zh/changelog' },
          { text: '开发者', link: '/zh/developers' },
        ],
        sidebar: sidebar('/zh', zh),
        editLink: { pattern: ({ filePath }) => `https://github.com/chengzhiyi/pi-webapp/edit/main/docs/${filePath}`, text: '在 GitHub 上编辑此页' },
        outline: { level: [2, 3], label: '本页内容' },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新于' },
        sidebarMenuLabel: '目录',
        returnToTopLabel: '回到顶部',
        langMenuLabel: '切换语言',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        footer: {
          message: '这些页面描述本仓库的源码。请在 <strong>Pi 设置 → 通用设置</strong> 中查看你正在运行的版本。',
          copyright: 'MIT 许可 · pi-webapp',
        },
      },
    },
  },

  themeConfig: {
    logo: '/logo.svg',
    search: {
      provider: 'local',
      options: {
        // Index Latin words plus single Han characters, so Chinese queries work without word breaks.
        miniSearch: {
          options: {
            tokenize: (text: string) => text.toLowerCase().match(/[a-z0-9_]+|\p{Script=Han}|[^\s\p{P}\p{S}a-z0-9_\p{Script=Han}]+/gu) || [],
          },
        },
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有找到结果',
                resetButtonTitle: '清除搜索',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: 'github', link: repo }],
  },
});
