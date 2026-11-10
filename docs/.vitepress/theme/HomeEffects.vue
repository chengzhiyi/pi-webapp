<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

// Two page-wide effects, both skipped under reduced motion:
// - cursor spotlight: writes the pointer position into CSS variables of the card under it;
// - scroll reveal: sections marked .home-reveal (and the feature grid) rise in once they are on screen.
// The reveal only hides anything after this script has opted in with .home-fx, so the page is
// complete without JavaScript.
let handler: ((event: PointerEvent) => void) | undefined;
let observer: IntersectionObserver | undefined;

onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  if (!matchMedia('(hover: none)').matches) {
    handler = (event) => {
      const card = (event.target as Element | null)?.closest<HTMLElement>('.VPFeature, .home-way, .home-fact, .flow-node');
      if (!card) return;
      const box = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - box.left}px`);
      card.style.setProperty('--my', `${event.clientY - box.top}px`);
    };
    document.addEventListener('pointermove', handler, { passive: true });
  }

  if (!('IntersectionObserver' in window)) return;
  document.querySelector('.VPHomeFeatures')?.classList.add('home-reveal');
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer?.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of document.querySelectorAll('.home-reveal')) observer.observe(el);
  document.documentElement.classList.add('home-fx');
});

onBeforeUnmount(() => {
  if (handler) document.removeEventListener('pointermove', handler);
  observer?.disconnect();
  document.documentElement.classList.remove('home-fx');
});
</script>

<template><span hidden></span></template>
