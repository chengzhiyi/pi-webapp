import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import HomeBackdrop from './HomeBackdrop.vue';
import HomeEffects from './HomeEffects.vue';
import HomeFlow from './HomeFlow.vue';
import HomeInstall from './HomeInstall.vue';
import HomeShowcase from './HomeShowcase.vue';
import HomeTerminal from './HomeTerminal.vue';
import HomeWays from './HomeWays.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  // The home page is the default home layout plus custom sections and a live terminal in the hero.
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-before': () => [h(HomeBackdrop), h(HomeEffects)],
    'home-hero-info-after': () => h(HomeInstall),
    'home-hero-image': () => h(HomeTerminal),
    'home-hero-after': () => h(HomeShowcase),
    'home-features-before': () => h(HomeFlow),
    'home-features-after': () => h(HomeWays),
  }),
};
