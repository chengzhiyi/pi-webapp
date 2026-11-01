<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useData } from 'vitepress';

type Kind = 'cmd' | 'ask' | 'ok' | 'tool' | 'text' | 'dim' | 'gap';
type Line = { kind: Kind; text: string };

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

// An illustrative session, not a recording.
const script = computed<Line[]>(() => zh.value
  ? [
      { kind: 'cmd', text: 'npx pi-webapp' },
      { kind: 'ok', text: '✓ 已在后台运行  http://127.0.0.1:52395' },
      { kind: 'gap', text: '' },
      { kind: 'ask', text: '为什么 50.00 美元的订单还要收运费？' },
      { kind: 'tool', text: '▸ read   src/shipping.js' },
      { kind: 'text', text: '  第 5 行用了严格大于，应该是 >=' },
      { kind: 'tool', text: '▸ edit   src/shipping.js   +1 −1' },
      { kind: 'tool', text: '▸ bash   npm test' },
      { kind: 'ok', text: '  ✔ 2 项通过' },
      { kind: 'dim', text: '✓ 完成 · 1,064 tokens' },
    ]
  : [
      { kind: 'cmd', text: 'npx pi-webapp' },
      { kind: 'ok', text: '✓ running  http://127.0.0.1:52395' },
      { kind: 'gap', text: '' },
      { kind: 'ask', text: 'Why is a $50.00 order still charged shipping?' },
      { kind: 'tool', text: '▸ read   src/shipping.js' },
      { kind: 'text', text: '  line 5 compares with > ; it should be >=' },
      { kind: 'tool', text: '▸ edit   src/shipping.js   +1 −1' },
      { kind: 'tool', text: '▸ bash   npm test' },
      { kind: 'ok', text: '  ✔ 2 passing' },
      { kind: 'dim', text: '✓ done · 1,064 tokens' },
    ]);

const shown = ref<Line[]>([]);
let alive = true;
let timer: ReturnType<typeof setTimeout> | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });

async function play() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    shown.value = script.value.map((l) => ({ ...l }));
    return;
  }
  while (alive) {
    shown.value = [];
    for (const step of script.value) {
      if (!alive) return;
      if (step.kind === 'cmd' || step.kind === 'ask') {
        const line: Line = { kind: step.kind, text: '' };
        shown.value = [...shown.value, line];
        for (const ch of step.text) {
          if (!alive) return;
          line.text += ch;
          shown.value = [...shown.value];
          await sleep(step.kind === 'cmd' ? 55 : 32);
        }
        await sleep(step.kind === 'cmd' ? 650 : 750);
      } else {
        shown.value = [...shown.value, { ...step }];
        await sleep(step.kind === 'gap' ? 150 : 480);
      }
    }
    await sleep(4200);
  }
}

onMounted(() => { void play(); });
onBeforeUnmount(() => { alive = false; clearTimeout(timer); });
</script>

<template>
  <div class="home-term" role="img" :aria-label="zh ? '示意：在终端里启动 pi-webapp，然后让 Pi 排查并修复一个问题' : 'Illustration: start pi-webapp, then ask Pi to find and fix a bug'">
    <div class="home-term-bar" aria-hidden="true">
      <i></i><i></i><i></i>
      <span>pi · shipping-calculator</span>
    </div>
    <pre class="home-term-body" aria-hidden="true"><template v-for="(l, i) in shown" :key="i"><span :class="['t-' + l.kind]"><b v-if="l.kind === 'cmd'">$ </b><b v-else-if="l.kind === 'ask'">› </b>{{ l.text }}<em v-if="i === shown.length - 1" class="t-caret"></em></span>
</template></pre>
    <div class="home-term-foot" aria-hidden="true">{{ zh ? '示意' : 'Illustration' }}</div>
  </div>
</template>
