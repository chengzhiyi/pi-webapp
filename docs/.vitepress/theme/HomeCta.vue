<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const href = (path: string) => withBase(`${zh.value ? '/zh' : ''}${path}`);
</script>

<template>
  <section class="home-cta home-reveal">
    <div class="home-cta-panel">
      <p class="home-eyebrow">{{ zh ? '一条命令' : 'one command' }}</p>
      <h2>{{ zh ? '给你的代理一个工作台' : 'Give your agent a workbench' }}</h2>
      <div class="home-cta-cmd"><span aria-hidden="true">$</span>npx pi-webapp</div>
      <div class="home-cta-actions">
        <a class="primary" :href="href('/getting-started')">{{ zh ? '快速开始' : 'Quick start' }}</a>
        <a :href="href('/desktop')">{{ zh ? '下载桌面应用' : 'Get the desktop app' }}</a>
        <a :href="href('/changelog')">{{ zh ? '更新日志' : 'Changelog' }}</a>
      </div>
    </div>
  </section>
</template>
