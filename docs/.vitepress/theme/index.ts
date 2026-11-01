import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import HomeInstall from './HomeInstall.vue';
import HomeShowcase from './HomeShowcase.vue';
import HomeWays from './HomeWays.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  // The home page is the default home layout plus three custom sections.
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-info-after': () => h(HomeInstall),
    'home-hero-after': () => h(HomeShowcase),
    'home-features-after': () => h(HomeWays),
  }),
};
