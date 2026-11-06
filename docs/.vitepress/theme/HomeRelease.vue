<script setup lang="ts">
import { computed } from 'vue';
import { useData, withBase } from 'vitepress';

// The latest-release badge above the hero title. Its text and link come from
// the `release` front matter of docs/en/index.md and docs/zh/index.md, which
// the release checklist updates together with the changelog.
const { frontmatter } = useData();
const release = computed(() => frontmatter.value.release as { label: string; text: string; link: string } | undefined);
</script>

<template>
  <a v-if="release" class="home-release" :href="withBase(release.link)">
    <span class="home-release-label">{{ release.label }}</span>
    <span class="home-release-text">{{ release.text }}</span>
    <span class="home-release-arrow" aria-hidden="true">→</span>
  </a>
</template>
