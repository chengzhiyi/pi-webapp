<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const copied = ref(false);
const command = 'npx pi-webapp';

async function copy() {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch { /* Clipboard unavailable: the command stays selectable. */ }
}
</script>

<template>
  <div class="home-install">
    <div class="home-install-box">
      <span class="home-install-prompt" aria-hidden="true">$</span>
      <code>{{ command }}</code>
      <button type="button" :aria-label="zh ? '复制命令' : 'Copy command'" @click="copy">
        <svg v-if="!copied" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>
        <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        <span>{{ copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy') }}</span>
      </button>
    </div>
    <p class="home-install-note">
      {{ zh ? '需要 Node.js 22.19 或更新版本 · 在项目目录里运行 · 默认只监听本机' : 'Needs Node.js 22.19 or later · run it in a project folder · listens on your machine only' }}
    </p>
  </div>
</template>
