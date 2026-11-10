<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData, withBase } from 'vitepress';

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));
const dir = computed(() => (zh.value ? '/images/zh/' : '/images/'));

type Tab = { id: string; label: string; image: string; title: string; text: string; file?: string; fresh?: boolean };
const tabs = computed<Tab[]>(() => zh.value
  ? [
      { id: 'conversation', label: '对话', image: 'conversation', title: '看着代理工作', text: '流式回复、可展开的工具调用和用量，都在同一个视图里。' },
      { id: 'files', label: '文件', image: 'files-preview', title: '边聊边看源码', text: '点击对话里的文件链接，就在旁边只读预览，带语法高亮。' },
      { id: 'git', label: 'Git', image: 'git-diff', title: '提交之前先审阅', text: '逐行查看差异，只暂存你想提交的部分。' },
      { id: 'terminal', label: '终端', image: 'terminal', title: '在真实的终端里验证', text: '运行项目自己的命令，切换会话也不会丢掉进程。' },
      { id: 'diagram', label: '图表', image: 'diagram-editor', title: '把想法变成可编辑的图', text: '让 Pi 画图，再在原生 Excalidraw 画布上继续修改。' },
      { id: 'design', label: '设计', image: 'openpencil', file: '/images/openpencil.webp', fresh: true, title: '说出界面，看着它出现', text: 'Pi 的修改直接落在 OpenPencil 画布上，最近的一次可以撤销。（截图为英文界面）' },
      { id: 'trajectory', label: '轨迹', image: 'trajectory', title: '清楚地知道发生了什么', text: '按轮次查看每次工具调用的耗时和 token 用量。' },
    ]
  : [
      { id: 'conversation', label: 'Conversation', image: 'conversation', title: 'Watch the agent work', text: 'Streaming replies, expandable tool calls and usage, all in one view.' },
      { id: 'files', label: 'Files', image: 'files-preview', title: 'Read the source beside the chat', text: 'Click a file link in the conversation and preview it next to it, with syntax highlighting.' },
      { id: 'git', label: 'Git', image: 'git-diff', title: 'Review before you commit', text: 'Read the diff line by line and stage only what you mean to commit.' },
      { id: 'terminal', label: 'Terminal', image: 'terminal', title: 'Verify in a real terminal', text: 'Run your project’s own commands. Switching chats doesn’t drop the process.' },
      { id: 'diagram', label: 'Diagrams', image: 'diagram-editor', title: 'Turn an idea into an editable diagram', text: 'Ask Pi to draw, then keep editing on a native Excalidraw canvas.' },
      { id: 'design', label: 'Design', image: 'openpencil', file: '/images/openpencil.webp', fresh: true, title: 'Describe a screen and watch it appear', text: 'Pi’s changes land on the OpenPencil canvas as it makes them, with Undo for the latest one.' },
      { id: 'trajectory', label: 'Trajectory', image: 'trajectory', title: 'Know exactly what happened', text: 'See every tool call with its timing and token usage, turn by turn.' },
    ]);

const active = ref('git');
const current = computed(() => tabs.value.find((t) => t.id === active.value) ?? tabs.value[0]);
const alt = computed(() => `${current.value.label}: ${current.value.title}`);
</script>

<template>
  <section class="home-showcase home-reveal" :aria-label="zh ? '界面一览' : 'Interface overview'">
    <div class="home-section-head">
      <p class="home-eyebrow">{{ zh ? '真实界面' : 'the real thing' }}</p>
      <h2>{{ zh ? '讨论 → 查看 → 审阅 → 验证' : 'Discuss → inspect → review → verify' }}</h2>
    </div>

    <div class="home-tabs" role="tablist">
      <button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :aria-selected="tab.id === active" :class="{ on: tab.id === active }" @click="active = tab.id">
        {{ tab.label }}<sup v-if="tab.fresh">{{ zh ? '新' : 'new' }}</sup>
      </button>
    </div>

    <figure class="home-window">
      <div class="home-window-bar" aria-hidden="true"><i></i><i></i><i></i><span>pi-webapp</span></div>
      <img :key="current.image" :src="withBase(current.file ?? `${dir}${current.image}.png`)" :alt="alt" loading="lazy" />
    </figure>
    <p class="home-caption"><strong>{{ current.title }}</strong> {{ current.text }}</p>
  </section>
</template>
