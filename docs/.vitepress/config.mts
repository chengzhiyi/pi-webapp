import { defineConfig } from 'vitepress';

const repo = 'https://github.com/chengzhiyi/pi-webapp';
// GitHub Pages serves a project site under /<repository>/.
const base = process.env.DOCS_BASE ?? '/pi-webapp/';

// The user guide lives in docs/en/ and is published at the site root, so a
// future translation can sit under /zh/ without moving any English URL.
const guide = [
  {
    text: 'Getting started',
    items: [
      { text: 'Introduction', link: '/introduction' },
      { text: 'Quick start', link: '/getting-started' },
      { text: 'Desktop app', link: '/desktop' },
      { text: 'Use it from the Pi terminal', link: '/use-from-pi' },
    ],
  },
  {
    text: 'Using pi-webapp',
    items: [
      { text: 'Conversations', link: '/conversation' },
      { text: 'Sessions and workspaces', link: '/sessions' },
      { text: 'Files, terminal and Git', link: '/workspace-tools' },
      { text: 'Diagrams with Excalidraw', link: '/diagrams' },
    ],
  },
  {
    text: 'Configuration',
    items: [
      { text: 'Overview', link: '/configuration' },
      { text: 'Models and providers', link: '/models' },
      { text: 'Packages, skills and plugins', link: '/extensions' },
      { text: 'Updates', link: '/updates' },
    ],
  },
  { text: 'Security and privacy', link: '/security' },
  {
    text: 'Help',
    items: [
      { text: 'Troubleshooting', link: '/troubleshooting' },
      { text: 'FAQ', link: '/faq' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Command line', link: '/reference/cli' },
      { text: 'Environment variables', link: '/reference/environment' },
      { text: 'Files and directories', link: '/reference/files' },
      { text: 'Limits', link: '/reference/limits' },
      { text: 'Glossary', link: '/reference/glossary' },
    ],
  },
  { text: 'Developers', link: '/developers' },
];

export default defineConfig({
  title: 'pi-webapp',
  description: 'User guide for pi-webapp: a browser and desktop workbench for the Pi coding agent.',
  lang: 'en',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }]],

  // Publish docs/en/ at the site root. Everything else under docs/ is
  // engineering material (design notes, release and CI records) that stays on
  // GitHub; the Developers page links to it instead of building it.
  rewrites: { 'en/:rest*': ':rest*' },
  srcExclude: ['*.md', 'ci/**', 'decisions/**', 'evidence/**', 'tests/**', 'zh/**', 'node_modules/**'],

  markdown: { image: { lazyLoading: true } },

  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/introduction', activeMatch: '^/(?!reference/|troubleshooting|faq|developers)' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference/' },
      { text: 'Troubleshooting', link: '/troubleshooting', activeMatch: '^/(troubleshooting|faq)' },
      { text: 'Developers', link: '/developers' },
    ],
    sidebar: guide,
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    editLink: {
      // Serialized into the client bundle: it must not close over variables.
      pattern: ({ filePath }) => `https://github.com/chengzhiyi/pi-webapp/edit/main/docs/${filePath}`,
      text: 'Edit this page on GitHub',
    },
    socialLinks: [{ icon: 'github', link: repo }],
    footer: {
      message: 'These pages describe the source in this repository. Check <strong>Pi Settings → General</strong> for the version you are running.',
      copyright: 'MIT licensed · pi-webapp',
    },
  },
});
