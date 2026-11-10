import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import HomeBackdrop from './HomeBackdrop.vue';
import HomeCta from './HomeCta.vue';
import HomeEffects from './HomeEffects.vue';
import HomeFlow from './HomeFlow.vue';
import HomeInstall from './HomeInstall.vue';
import HomeRelease from './HomeRelease.vue';
import HomeShowcase from './HomeShowcase.vue';
import HomeStage from './HomeStage.vue';
import HomeWays from './HomeWays.vue';
import './style.css';
import './home.css';

export default {
  extends: DefaultTheme,
  // The home page is the default home layout plus custom sections; the animated stage sits right under the hero.
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-before': () => [h(HomeBackdrop), h(HomeEffects)],
    'home-hero-info-before': () => h(HomeRelease),
    'home-hero-info-after': () => h(HomeInstall),
    'home-hero-after': () => [h(HomeStage), h(HomeShowcase)],
    'home-features-before': () => h(HomeFlow),
    'home-features-after': () => [h(HomeWays), h(HomeCta)],
  }),
};
