<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

// Cursor spotlight on cards: writes the pointer position into CSS variables of the card under it.
let handler: ((event: PointerEvent) => void) | undefined;

onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(hover: none)').matches) return;
  handler = (event) => {
    const card = (event.target as Element | null)?.closest<HTMLElement>('.VPFeature, .home-way, .home-fact, .flow-node');
    if (!card) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - box.left}px`);
    card.style.setProperty('--my', `${event.clientY - box.top}px`);
  };
  document.addEventListener('pointermove', handler, { passive: true });
});

onBeforeUnmount(() => { if (handler) document.removeEventListener('pointermove', handler); });
</script>

<template><span hidden></span></template>
