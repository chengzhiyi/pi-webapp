<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const p = computed(() => (zh.value ? '/zh' : ''));
const href = (path: string) => withBase(`${p.value}${path}`);

const ways = computed(() => zh.value
  ? [
      { name: 'Web 启动器', code: 'npx pi-webapp', text: '大多数人的选择。后台服务，关掉终端和标签页都不会停。', link: '/getting-started', cta: '快速开始' },
      { name: '在 Pi 终端里', code: '/web', text: '已经在用 Pi 的终端界面？在浏览器里看同一个会话。', link: '/use-from-pi', cta: '了解如何使用' },
      { name: '桌面应用', code: 'pi.app', text: '自带 Node.js 和 Pi 的独立窗口，无需另外安装。', link: '/desktop', cta: '下载与安装' },
    ]
  : [
      { name: 'Web launcher', code: 'npx pi-webapp', text: 'The default choice. A background service that keeps running when you close the terminal or the tab.', link: '/getting-started', cta: 'Quick start' },
      { name: 'Inside Pi', code: '/web', text: 'Already in Pi’s terminal interface? Get a browser view of the same session.', link: '/use-from-pi', cta: 'How it works' },
      { name: 'Desktop app', code: 'pi.app', text: 'Its own window with Node.js and Pi bundled, nothing else to install.', link: '/desktop', cta: 'Download and install' },
    ]);

const facts = computed(() => zh.value
  ? [
      { k: '127.0.0.1', v: '只监听本机' },
      { k: '访问令牌', v: '每个请求都要校验' },
      { k: '默认无遥测', v: '错误上报需手动开启' },
      { k: 'MIT', v: '开源许可' },
    ]
  : [
      { k: '127.0.0.1', v: 'Listens on your machine only' },
      { k: 'Access token', v: 'Checked on every request' },
      { k: 'No telemetry', v: 'Error reporting is opt-in' },
      { k: 'MIT', v: 'Open source license' },
    ]);
</script>

<template>
  <section class="home-ways">
    <div class="home-section-head">
      <p class="home-eyebrow">{{ zh ? '开始使用' : 'Get started' }}</p>
      <h2>{{ zh ? '选一种适合你的方式' : 'Pick the way that fits you' }}</h2>
      <p class="home-lead">{{ zh ? '三种方式用的是同一个工作台，也共用同一份 Pi 数据。' : 'All three show the same workbench and share the same Pi data.' }}</p>
    </div>
    <div class="home-ways-grid">
      <a v-for="w in ways" :key="w.name" class="home-way" :href="href(w.link)">
        <span class="home-way-name">{{ w.name }}</span>
        <code>{{ w.code }}</code>
        <span class="home-way-text">{{ w.text }}</span>
        <span class="home-way-cta">{{ w.cta }} →</span>
      </a>
    </div>
  </section>

  <section class="home-trust">
    <div class="home-facts">
      <div v-for="f in facts" :key="f.k" class="home-fact">
        <strong>{{ f.k }}</strong>
        <span>{{ f.v }}</span>
      </div>
    </div>
    <p class="home-trust-note">
      {{ zh ? '代理和终端以你自己的用户权限运行，不是沙箱。' : 'The agent and terminal run with your own permissions; this is not a sandbox.' }}
      <a :href="href('/security')">{{ zh ? '阅读安全与隐私 →' : 'Read Security and privacy →' }}</a>
    </p>
  </section>
</template>
