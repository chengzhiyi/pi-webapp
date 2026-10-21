import { test, expect } from '@playwright/test';

// Exercise the generated production site, not Vite's source/dev fallback.
test('project-base deep link, reload, language counterpart and narrow layout', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().startsWith('http://127.0.0.1:4175/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('./zh/getting-started.html');
  await expect(page.locator('h1')).toHaveText('安装与首次对话');
  await expect(page.locator('.docs-version')).toContainText('开发版文档');
  await page.reload();
  await expect(page.locator('h1')).toHaveText('安装与首次对话');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('guide-zh.png'), fullPage: true });
  const language = page.locator('.VPNavBarTranslations');
  // Narrow layouts put translations in the navigation menu rather than the desktop bar.
  if (await language.isVisible()) {
    await language.locator('button').click();
    await language.getByRole('link', { name: 'English', exact: true }).click();
  } else {
    await page.getByRole('button', { name: /mobile navigation/i }).click();
    await page.locator('.VPNavScreen').getByRole('link', { name: 'English', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/pi-webapp\/en\/getting-started(?:\.html)?$/);
  await expect(page.locator('h1')).toHaveText('Install & first conversation');
  await expect(page.locator('.docs-version')).toContainText('Development docs');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Chinese and English local search, keyboard open/select/escape', async ({ page }) => {
  await page.goto('./zh/');
  // Wait until hydration installs the keyboard listener.
  await expect(page.locator('.VPNavBarSearch button')).toBeVisible();
  await page.locator('.VPNavBarSearch button').click();
  const search = page.locator('#localsearch-input');
  await expect(search).toBeVisible();
  await search.fill('遥测');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('安全与隐私');
  // A shorter substring also finds Chinese text without spaces between words.
  await search.fill('采集');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('安全与隐私');
  await search.press('Escape');
  await expect(search).not.toBeVisible();
  await page.goto('./en/');
  await page.keyboard.press('Control+k');
  await expect(search).toBeVisible();
  await search.fill('recovery');
  await expect(page.locator('.VPLocalSearchBox .results')).toContainText('Updates');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/en\/updates/);
});
