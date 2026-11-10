<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useData } from 'vitepress';

// The home page's centrepiece: a looping illustration of the workbench, not a recording. A plugin
// goes fullscreen, the floating message box takes an instruction, and Pi operates the plugin until
// the result is on screen. Then the next plugin takes over. Tool names are the real ones.
type SceneId = 'pencil' | 'excalidraw' | 'terminal' | 'git';
type Scene = { id: SceneId; name: string; ask: string; tool: string; done: string; steps: number; pace: number; icon: string };

const { lang } = useData();
const zh = computed(() => lang.value.startsWith('zh'));

const scenes = computed<Scene[]>(() => [
  {
    id: 'pencil', name: 'OpenPencil', tool: 'pencil_apply_changes', steps: 10, pace: 360,
    ask: zh.value ? '设计登录页和仪表盘两个手机界面' : 'Design a sign-in screen and a dashboard',
    done: zh.value ? '2 个画框 · 可撤销' : '2 frames · undo available',
    icon: 'm4 20 1.2-4.8L16.5 3.9a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L8.8 18.8 4 20zM14 6.5l3.5 3.5',
  },
  {
    id: 'excalidraw', name: 'Excalidraw', tool: 'excalidraw_create_view', steps: 7, pace: 520,
    ask: zh.value ? '画出登录请求的流程图' : 'Draw how a sign-in request flows',
    done: zh.value ? '4 个节点 · 3 条连线' : '4 nodes · 3 arrows',
    icon: 'M4 5h7v6H4zM13 13h7v6h-7zM11 8h3.5a2 2 0 0 1 2 2v3',
  },
  {
    id: 'terminal', name: zh.value ? '终端' : 'Terminal', tool: 'terminal_send', steps: 7, pace: 560,
    ask: zh.value ? '在这个终端里跑一下测试' : 'Run the tests in this terminal',
    done: zh.value ? '12 项通过' : '12 passed',
    icon: 'M4 5h16v14H4zM7.5 10l2.5 2-2.5 2M12.5 14h4',
  },
  {
    id: 'git', name: 'Git', tool: 'edit', steps: 6, pace: 480,
    ask: zh.value ? '修复包邮门槛的判断' : 'Fix the free-shipping threshold',
    done: zh.value ? '+1 −1 · 等你审阅' : '+1 −1 · ready to review',
    icon: 'M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 8.5v7M18 11.5c0 3-3 3.5-6 3.5H8.5',
  },
]);

// Rendered finished on the server and under reduced motion; the film starts in the browser.
const index = ref(0);
const scene = computed(() => scenes.value[index.value]);
const full = ref(true);
const cursor = ref<'rest' | 'fs' | 'hide'>('hide');
const pressed = ref(false);
const composer = ref<'off' | 'typing' | 'working' | 'done'>('done');
const typed = ref('');
const step = ref(99);
const shown = computed(() => (composer.value === 'typing' ? typed.value : scene.value.ask));

let alive = true;
let animated = false;
let run = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const sleep = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
  timers.add(timer);
});

async function play(i: number, intro: boolean) {
  const id = ++run;
  const wait = async (ms: number) => { await sleep(ms); return alive && id === run; };
  index.value = i;
  step.value = 0;
  typed.value = '';
  composer.value = 'off';
  pressed.value = false;
  if (intro) {
    // Chat and plugin side by side; the pointer goes to the fullscreen button and presses it.
    full.value = false;
    cursor.value = 'rest';
    if (!(await wait(1100))) return;
    cursor.value = 'fs';
    if (!(await wait(900))) return;
    pressed.value = true;
    if (!(await wait(240))) return;
    full.value = true;
    pressed.value = false;
    cursor.value = 'hide';
    if (!(await wait(950))) return;
  } else {
    full.value = true;
    cursor.value = 'hide';
    if (!(await wait(550))) return;
  }
  composer.value = 'typing';
  for (const ch of scenes.value[i].ask) {
    typed.value += ch;
    if (!(await wait(zh.value ? 70 : 36))) return;
  }
  if (!(await wait(480))) return;
  composer.value = 'working';
  if (!(await wait(650))) return;
  for (let s = 1; s <= scenes.value[i].steps; s++) {
    step.value = s;
    if (!(await wait(scenes.value[i].pace))) return;
  }
  composer.value = 'done';
  if (!(await wait(3200))) return;
  const next = (i + 1) % scenes.value.length;
  void play(next, next === 0);
}

function pick(i: number) {
  if (animated) { void play(i, false); return; }
  index.value = i;
}

onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  animated = true;
  void play(0, true);
});
onBeforeUnmount(() => {
  alive = false;
  for (const timer of timers) clearTimeout(timer);
});

const on = (n: number) => ({ on: step.value >= n });
// OpenPencil's layer list: one row per build step, children indented under their frame.
const layers = [70, 46, 62, 80, 80, 58, 74, 52, 66].map((w, i) => ({ w, inset: i === 0 || i === 6 ? 0 : 10 }));
const approval = computed(() => (zh.value
  ? { title: 'Pi 想在终端中输入', allow: '允许', deny: '拒绝' }
  : { title: 'Pi wants to type into the terminal', allow: 'Allow', deny: 'Deny' }));
</script>

<template>
  <section class="home-film" :aria-label="zh ? '插件演示' : 'Plugins in action'">
    <div class="film-dock">
      <button v-for="(s, i) in scenes" :key="s.id" type="button" :class="{ on: i === index }" :aria-pressed="i === index" @click="pick(i)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="s.icon" /></svg>
        <span>{{ s.name }}</span>
      </button>
    </div>

    <div class="film" :class="[`sc-${scene.id}`, `c-${composer}`, { full }]" role="img"
      :aria-label="zh ? '示意：插件进入全屏，在悬浮输入框里给 Pi 下达指令，Pi 操作插件并生成结果' : 'Illustration: a plugin goes fullscreen, the floating message box takes an instruction, and Pi operates the plugin until the result appears'">
      <div class="film-bar" aria-hidden="true">
        <i></i><i></i><i></i>
        <span>pi-webapp</span>
        <span class="film-note">{{ zh ? '示意' : 'Illustration' }}</span>
      </div>

      <div class="film-body" aria-hidden="true">
        <div class="film-rail"><i></i><i></i><i></i><i></i></div>

        <div class="film-chat">
          <div class="film-msg me"><i style="width: 78%"></i><i style="width: 52%"></i></div>
          <div class="film-msg"><i style="width: 92%"></i><i style="width: 84%"></i><i style="width: 61%"></i></div>
          <div class="film-msg tool"><i style="width: 46%"></i></div>
          <div class="film-msg"><i style="width: 88%"></i><i style="width: 40%"></i></div>
          <div class="film-input"><i></i></div>
        </div>

        <div class="film-panel">
          <div class="film-tabs">
            <span class="film-tab">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="scene.icon" /></svg>
              {{ scene.name }}
            </span>
            <span class="film-tab ghost"></span>
            <span class="film-fs" :class="{ pressed, active: full }">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></svg>
            </span>
          </div>

          <div class="film-view">
            <!-- OpenPencil: layers, two frames built layer by layer, properties -->
            <div v-show="scene.id === 'pencil'" class="film-scene v-pencil">
              <div class="pc-side">
                <i v-for="(l, n) in layers" :key="n" :class="on(n + 1)" :style="{ width: `${l.w}%`, marginLeft: `${l.inset}px` }"></i>
              </div>
              <div class="pc-canvas">
                <div class="pc-phone" :class="[on(1), { sel: step >= 10 }]">
                  <b>Sign in</b>
                  <i class="p-logo" :class="on(2)"></i>
                  <i class="p-h1" :class="on(3)"></i>
                  <i class="p-h2" :class="on(3)"></i>
                  <i class="p-field" :class="on(4)"></i>
                  <i class="p-field" :class="on(5)"></i>
                  <i class="p-cta" :class="on(6)"></i>
                </div>
                <div class="pc-phone alt" :class="[on(7), { sel: step >= 10 }]">
                  <b>Dashboard</b>
                  <i class="p-h1" :class="on(8)"></i>
                  <span class="p-stats" :class="on(8)"><i></i><i></i></span>
                  <span class="p-list" :class="on(9)"><i></i><i></i><i></i></span>
                </div>
                <div class="pc-toast" :class="on(10)"><span>{{ zh ? 'Agent 已修改' : 'Agent changed' }}</span><b>{{ zh ? '撤销' : 'Undo' }}</b></div>
              </div>
              <div class="pc-props"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            </div>

            <!-- Excalidraw: nodes and arrows draw themselves -->
            <div v-show="scene.id === 'excalidraw'" class="film-scene v-excalidraw">
              <svg viewBox="0 0 640 300" preserveAspectRatio="xMidYMid meet">
                <g :class="on(1)" class="ex-node c1"><rect x="40" y="118" width="130" height="64" rx="14" pathLength="1" /><text x="105" y="156">Browser</text></g>
                <path :class="on(2)" class="ex-arrow" d="M176 150 C198 146 214 153 238 150 M228 143 L239 150 L228 158" pathLength="1" />
                <g :class="on(3)" class="ex-node c2"><rect x="246" y="118" width="130" height="64" rx="14" pathLength="1" /><text x="311" y="156">API</text></g>
                <path :class="on(4)" class="ex-arrow" d="M382 138 C408 128 424 96 452 82 M440 80 L453 81 L447 93" pathLength="1" />
                <g :class="on(5)" class="ex-node c3"><rect x="460" y="36" width="140" height="64" rx="14" pathLength="1" /><text x="530" y="74">Auth</text></g>
                <path :class="on(6)" class="ex-arrow" d="M382 164 C408 176 424 206 452 220 M447 208 L453 221 L440 222" pathLength="1" />
                <g :class="on(7)" class="ex-node c4"><rect x="460" y="200" width="140" height="64" rx="14" pathLength="1" /><text x="530" y="238">Sessions DB</text></g>
              </svg>
            </div>

            <!-- Terminal: the approval card, then the command and its output -->
            <div v-show="scene.id === 'terminal'" class="film-scene v-terminal">
              <pre><span>~/shop <b>main</b> $ <template v-if="step >= 3">npm test</template><em v-if="step < 4" class="tm-caret"></em></span>
<span :class="on(4)" class="dim">&gt; vitest run</span>
<span :class="on(5)"><u>✓</u> test/shipping.test.js <i>(4)</i></span>
<span :class="on(6)"><u>✓</u> test/cart.test.js <i>(8)</i></span>
<span :class="on(7)"> </span>
<span :class="on(7)"><u>Tests  12 passed</u> <i>(12)</i></span></pre>
              <div class="tm-approval" :class="{ on: step >= 1 && step < 3 }">
                <strong>{{ approval.title }}</strong>
                <code>npm test</code>
                <span><b :class="{ hit: step >= 2 }">{{ approval.allow }}</b><i>{{ approval.deny }}</i></span>
              </div>
            </div>

            <!-- Git: the changed file and its diff -->
            <div v-show="scene.id === 'git'" class="film-scene v-git">
              <div class="gt-files">
                <span class="dimrow"><i style="width: 54%"></i></span>
                <span :class="on(1)" class="gt-file">shipping.js <b>M</b></span>
                <span class="dimrow"><i style="width: 66%"></i></span>
                <span class="dimrow"><i style="width: 42%"></i></span>
              </div>
              <pre class="gt-diff"><span :class="on(2)" class="hunk">@@ -3,7 +3,7 @@ export function shippingFor(total)</span>
<span :class="on(5)"><i>4</i>   const FREE_FROM = 50;</span>
<span :class="on(3)" class="del"><i>5</i> - if (total &gt; FREE_FROM) return 0;</span>
<span :class="on(4)" class="add"><i>5</i> + if (total &gt;= FREE_FROM) return 0;</span>
<span :class="on(5)"><i>6</i>   return FLAT_RATE;</span>
<span :class="on(5)"><i>7</i> }</span></pre>
              <span class="gt-stat" :class="on(6)"><b>+1</b> <i>−1</i></span>
            </div>

            <!-- The floating message box -->
            <div class="film-composer">
              <span class="fc-orb"></span>
              <span v-if="composer === 'working'" class="fc-text work">Pi <i>▸</i> <code>{{ scene.tool }}</code><em></em></span>
              <span v-else-if="composer === 'done'" class="fc-text done"><u>✓</u> {{ scene.done }}</span>
              <span v-else class="fc-text">{{ shown }}<em class="fc-caret"></em></span>
              <span class="fc-send"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg></span>
            </div>
          </div>
        </div>

        <i class="film-cursor" :class="[`at-${cursor}`, { pressed }]"></i>
      </div>
    </div>
  </section>
</template>
