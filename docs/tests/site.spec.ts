import { test, expect } from '@playwright/test';

// These tests exercise the generated production site (vitepress preview), not the dev server.

test('deep link, reload, sidebar navigation and narrow layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().startsWith('http://127.0.0.1:4175/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./getting-started');
  await expect(page.locator('h1')).toHaveText('Quick start');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Quick start');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Follow an in-content link; on narrow layouts the sidebar sits behind a menu button.
  await page.locator('.vp-doc').getByRole('link', { name: 'Conversations' }).first().click();
  await expect(page).toHaveURL(/\/conversation$/);
  await expect(page.locator('h1')).toHaveText('Conversations');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('every screenshot on a content-heavy page loads', async ({ page }) => {
  await page.goto('./workspace-tools');
  await page.locator('.vp-doc img').last().scrollIntoViewIfNeeded();
  const images = page.locator('.vp-doc img');
  expect(await images.count()).toBeGreaterThan(2);
  await expect.poll(() => images.evaluateAll((all) => all.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
});

test('local search opens from the keyboard and finds a page by its content', async ({ page }) => {
  await page.goto('./');
  // Wait until hydration installs the keyboard listener.
  await page.waitForFunction(() => Boolean((document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown })?.__vue_app__));
  await page.keyboard.press('Control+k');
  const search = page.locator('#localsearch-input');
  await expect(search).toBeVisible();
  await search.fill('stop --force');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('Troubleshooting');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/(troubleshooting|reference\/cli)/);
  await page.keyboard.press('Escape');
});

test('dark mode toggles and persists across reload', async ({ page }) => {
  await page.goto('./introduction');
  await page.waitForFunction(() => Boolean((document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown })?.__vue_app__));
  const html = page.locator('html');
  const before = await html.evaluate((el) => el.classList.contains('dark'));
  // The appearance switch lives in the nav bar on wide screens and in the navigation menu on narrow ones.
  const toggle = page.locator('.VPSwitchAppearance:visible').first();
  if (await toggle.count()) await toggle.click();
  else {
    await page.getByRole('button', { name: /mobile navigation/i }).click();
    await page.locator('.VPNavScreen .VPSwitchAppearance').click();
  }
  await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(!before);
  await page.reload();
  await expect.poll(() => html.evaluate((el) => el.classList.contains('dark'))).toBe(!before);
});

test('edit link points at the source file and code blocks are copyable', async ({ page }) => {
  await page.goto('./getting-started');
  const edit = page.locator('.edit-link a');
  await expect(edit).toHaveAttribute('href', 'https://github.com/chengzhiyi/pi-webapp/edit/main/docs/en/getting-started.md');
  await expect(page.locator('.vp-doc div[class*="language-"] button.copy').first()).toBeAttached();
});

test('language switch keeps the page: English to Chinese and back, with Chinese search', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./getting-started');
  await expect(page.locator('h1')).toHaveText('Quick start');
  // On wide screens the language menu is in the nav bar; on narrow ones it is inside the navigation menu.
  const switchTo = async (name: string) => {
    const bar = page.locator('.VPNavBarTranslations');
    if (await bar.isVisible()) {
      await bar.locator('button').click();
      await bar.getByRole('link', { name, exact: true }).click();
    } else {
      await page.getByRole('button', { name: /mobile navigation/i }).click();
      await page.locator('.VPNavScreen').getByRole('link', { name, exact: true }).click();
    }
  };
  await switchTo('简体中文');
  await expect(page).toHaveURL(/\/zh\/getting-started$/);
  await expect(page.locator('h1')).toHaveText('快速开始');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Chinese screenshots (the Chinese-interface set) load on the Chinese page.
  await page.locator('.vp-doc img').last().scrollIntoViewIfNeeded();
  const images = page.locator('.vp-doc img');
  await expect.poll(() => images.evaluateAll((all) => all.length > 0 && all.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  expect(await images.first().getAttribute('src')).toContain('/images/zh/');

  // Chinese substring search works without spaces between words.
  await page.waitForFunction(() => Boolean((document.querySelector('#app') as HTMLElement & { __vue_app__?: unknown })?.__vue_app__));
  await page.keyboard.press('Control+k');
  const search = page.locator('#localsearch-input');
  await expect(search).toBeVisible();
  await search.fill('访问令牌');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('安全与隐私');
  await search.press('Escape');

  await switchTo('English');
  await expect(page).toHaveURL(/\/getting-started$/);
  await expect(page.locator('h1')).toHaveText('Quick start');
  expect(errors).toEqual([]);
});

test('the Chinese edit link points at the Chinese source file', async ({ page }) => {
  await page.goto('./zh/troubleshooting');
  await expect(page.locator('h1')).toHaveText('排错');
  await expect(page.locator('.edit-link a')).toHaveAttribute('href', 'https://github.com/chengzhiyi/pi-webapp/edit/main/docs/zh/troubleshooting.md');
});

test('home page: install command, screenshot tabs and the Chinese home', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.home-install code')).toHaveText('npx pi-webapp');
  const image = page.locator('.home-window img');
  const before = await image.getAttribute('src');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(image).not.toHaveAttribute('src', before!);
  await expect(image).toHaveAttribute('src', /\/images\/terminal\.png$/);
  await expect(page.locator('.home-way')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.goto('./zh/');
  await expect(page.locator('.home-install-box button')).toContainText('复制');
  await page.getByRole('tab', { name: '终端' }).click();
  await expect(page.locator('.home-window img')).toHaveAttribute('src', /\/images\/zh\/terminal\.png$/);
});
