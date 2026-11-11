<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

// Decorative only: a slow network of nodes behind the hero. It pauses when the tab is hidden,
// draws a single static frame when the visitor prefers reduced motion, and ignores pointer input
// on touch screens.
const canvas = ref<HTMLCanvasElement | null>(null);
let frame = 0;
let stop = () => {};

onMounted(() => {
  const el = canvas.value;
  const ctx = el?.getContext('2d');
  if (!el || !ctx) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  type Node = { x: number; y: number; vx: number; vy: number; r: number };
  let nodes: Node[] = [];
  const pointer = { x: -9999, y: -9999 };

  const resize = () => {
    const box = el.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    width = box.width;
    height = box.height;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.max(18, Math.min(64, Math.round(width / 22)));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: 1 + Math.random() * 1.6,
    }));
  };

  const draw = () => {
    const dark = document.documentElement.classList.contains('dark');
    const rgb = dark ? '150, 175, 255' : '70, 100, 225';
    ctx.clearRect(0, 0, width, height);
    const reach = 130;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!reduced) {
        a.x += a.vx;
        a.y += a.vy;
        if (a.x < -10) a.x = width + 10;
        if (a.x > width + 10) a.x = -10;
        if (a.y < -10) a.y = height + 10;
        if (a.y > height + 10) a.y = -10;
      }
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < reach) {
          ctx.strokeStyle = `rgba(${rgb}, ${(1 - d / reach) * (dark ? 0.32 : 0.28)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      const p = Math.hypot(a.x - pointer.x, a.y - pointer.y);
      if (p < 170) {
        ctx.strokeStyle = `rgba(${rgb}, ${(1 - p / 170) * 0.55})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(pointer.x, pointer.y);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${rgb}, ${dark ? 0.8 : 0.65})`;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const loop = () => {
    draw();
    frame = requestAnimationFrame(loop);
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const box = el.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
  };
  const onVisibility = () => {
    cancelAnimationFrame(frame);
    if (!document.hidden && !reduced) loop();
  };

  resize();
  draw();
  if (!reduced) loop();
  addEventListener('resize', resize);
  addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  stop = () => {
    cancelAnimationFrame(frame);
    removeEventListener('resize', resize);
    removeEventListener('pointermove', onMove);
    document.removeEventListener('visibilitychange', onVisibility);
  };
});

onBeforeUnmount(() => stop());
</script>

<template>
  <div class="home-backdrop" aria-hidden="true">
    <div class="home-orb home-orb-a"></div>
    <div class="home-orb home-orb-b"></div>
    <div class="home-orb home-orb-c"></div>
    <div class="home-grid"></div>
    <canvas ref="canvas"></canvas>
    <div class="home-horizon"></div>
  </div>
</template>
