<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

const nodes = computed(() => zh.value
  ? [
      { id: 'browser', title: '浏览器 / 桌面窗口', sub: '同一个工作台', icon: 'M3 5h18v14H3zM3 9h18' },
      { id: 'service', title: '本地服务', sub: '127.0.0.1 · 随机端口 · 访问令牌', icon: 'M4 6h16v5H4zM4 13h16v5H4zM8 8.5h.01M8 15.5h.01' },
      { id: 'pi', title: 'Pi 代理', sub: '工具 · 会话 · 技能', icon: 'M12 3l2.2 5.3L20 9l-4.2 3.9L17 19l-5-2.9L7 19l1.2-6.1L4 9l5.8-.7z' },
      { id: 'model', title: '模型提供方', sub: '你自己选的服务', icon: 'M12 4a8 8 0 100 16 8 8 0 000-16zM4 12h16M12 4c2.5 2.3 3.8 5 3.8 8s-1.3 5.7-3.8 8c-2.5-2.3-3.8-5-3.8-8S9.5 6.3 12 4z' },
    ]
  : [
      { id: 'browser', title: 'Browser or desktop window', sub: 'The same workbench', icon: 'M3 5h18v14H3zM3 9h18' },
      { id: 'service', title: 'Local service', sub: '127.0.0.1 · random port · access token', icon: 'M4 6h16v5H4zM4 13h16v5H4zM8 8.5h.01M8 15.5h.01' },
      { id: 'pi', title: 'Pi agent', sub: 'Tools · sessions · skills', icon: 'M12 3l2.2 5.3L20 9l-4.2 3.9L17 19l-5-2.9L7 19l1.2-6.1L4 9l5.8-.7z' },
      { id: 'model', title: 'Model provider', sub: 'The service you chose', icon: 'M12 4a8 8 0 100 16 8 8 0 000-16zM4 12h16M12 4c2.5 2.3 3.8 5 3.8 8s-1.3 5.7-3.8 8c-2.5-2.3-3.8-5-3.8-8S9.5 6.3 12 4z' },
    ]);
const links = computed(() => zh.value ? ['本机+令牌', 'RPC', 'HTTPS'] : ['localhost+token', 'RPC', 'HTTPS']);
</script>

<template>
  <section class="home-flow" :aria-label="zh ? '架构示意' : 'Architecture'">
    <div class="home-section-head">
      <p class="home-eyebrow">{{ zh ? '工作原理' : 'how it fits together' }}</p>
      <h2>{{ zh ? '代理在你的机器上，只有模型请求会出门' : 'The agent runs on your machine. Only model requests leave it.' }}</h2>
      <p class="home-lead">{{ zh ? '浏览器和 Pi 之间只隔着一个本地服务，没有 pi-webapp 自己的云。' : 'One local service sits between the browser and Pi. There is no pi-webapp cloud.' }}</p>
    </div>

    <div class="flow">
      <div class="flow-local">
        <span class="flow-tag">{{ zh ? '你的机器' : 'your machine' }}</span>
        <template v-for="(n, i) in nodes.slice(0, 3)" :key="n.id">
          <div class="flow-node">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="n.icon" /></svg>
            <strong>{{ n.title }}</strong>
            <span>{{ n.sub }}</span>
          </div>
          <div class="flow-link" aria-hidden="true"><em>{{ links[i] }}</em><i></i></div>
        </template>
      </div>
      <div class="flow-remote">
        <span class="flow-tag">{{ zh ? '你选的提供方' : 'your provider' }}</span>
        <div class="flow-node">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="nodes[3].icon" /></svg>
          <strong>{{ nodes[3].title }}</strong>
          <span>{{ nodes[3].sub }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
