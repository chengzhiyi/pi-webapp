import { test, expect } from "@playwright/test";
import { boxes, hostedParity, pluginId } from "../helpers/hosted-parity.ts";

for (const locale of ["en", "zh"] as const) test(`uninstall removes launchers and owned tabs, offers reinstall and retains drawings (${locale})`, async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Explicit independently built archive required");
  test.setTimeout(90_000);
  const h = await hostedParity(page, { locale, width: locale === "zh" ? 390 : 1440 });
  let lost: any;
  const t = (en: string, zh: string) => locale === "en" ? en : zh;
  try {
    const created = await h.tool("excalidraw_create_view", boxes());
    const generation = (await h.card()).generation!;
    const identity = { pluginId, sessionId: h.sessionId, generation, mountId: "departed-editor" };
    const { viewToken } = await h.integration.handlers.views({ ...identity, operation: "register", kind: "editor" }) as any;
    lost = { ...identity, viewToken, kind: "editor", contentId: created.id };
    await page.addInitScript(record => { if (location.protocol === "http:") sessionStorage.setItem("pi:hosted:unconfirmed-views:v1", JSON.stringify([record])); }, lost);
    await page.goto(h.bridge.url);
    const editor = await h.open();
    await editor.locator("canvas.interactive").click(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape");
    await expect.poll(async () => (await h.action("get", { id: created.id })).scene.elements[0].x).not.toBe(0);
    const checkpoint = (await h.action("get", { id: created.id })).scene.elements;
    await expect(page.locator("[data-hosted-recovery]")).toHaveCount(0);
    await page.getByRole("button", { name: t("New tab", "新标签页"), exact: true }).click();
    const guide = page.locator('[role="group"]').filter({ has: page.getByRole("button", { name: "Excalidraw", exact: true }) });
    const workspaceIcon = await guide.getByRole("button", { name: "Excalidraw", exact: true }).locator("svg").innerHTML();
    await page.locator("[data-sidebar-right-toggle]").click();
    await page.getByRole("button", { name: t("Plugins", "插件"), exact: true }).click();
    const management = page.locator("[data-hosted-management]");
    await management.getByRole("button", { name: t("Excalidraw (Official)", "Excalidraw（官方）"), exact: true }).click();
    expect(await management.locator("[data-hosted-detail] svg").first().innerHTML()).toBe(workspaceIcon);
    // The actual old editor is still mounted during management and every failed operation.
    const uninstall = management.getByRole("button", { name: t("Uninstall", "卸载"), exact: true });
    const confirm = page.getByRole("dialog", { name: t("Uninstall Excalidraw?", "卸载 Excalidraw？"), exact: true });
    await uninstall.click(); await confirm.getByRole("button", { name: t("Uninstall", "卸载"), exact: true }).click();
    await expect(management.getByRole("alert")).toContainText(t("Save confirmation", "保存确认"));
    expect((await h.card()).enabled).toBe(true); expect((await h.card()).installed).toBe(true);
    await expect(page.locator('iframe[title="Excalidraw editor"]')).toHaveCount(1);
    const recovery = page.locator("[data-hosted-recovery]");
    await expect(recovery).toBeVisible();
    expect(await recovery.evaluate(e => getComputedStyle(e).position)).not.toBe("fixed");
    await recovery.getByRole("button").click();
    const recoveryDialog = page.getByRole("dialog", { name: t("Review previous plugin views", "检查刷新前的插件视图"), exact: true });
    await expect(recoveryDialog).toContainText(t("Reloading interrupted", "刷新中断"));
    await recoveryDialog.locator('[data-unconfirmed-view="departed-editor"]').getByRole("button").click();
    await page.getByRole("dialog", { name: t("Discard this view's unconfirmed edits?", "丢弃此视图的未确认修改？"), exact: true }).getByRole("button", { name: t("Discard edits", "确认丢弃"), exact: true }).click();
    lost = null;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await uninstall.click(); await confirm.getByRole("button", { name: t("Uninstall", "卸载"), exact: true }).click();
    await expect(management).toContainText(t("Not installed · Disabled", "未安装 · 未启用"));
    await expect(uninstall).toHaveCount(0);
    await page.getByRole("button", { name: t("Refresh plugins", "刷新插件"), exact: true }).click();
    await expect(management.getByRole("button", { name: t("Reinstall", "重新安装"), exact: true })).toBeEnabled();
    await expect(page.locator('iframe[title^="Excalidraw "]')).toHaveCount(0);
    await expect(page.locator('[role="tab"]').filter({ hasText: "Excalidraw" })).toHaveCount(0);
    // Starting a new workbench tab cannot revive a launcher supplied by the history fallback.
    await expect(page.locator('[aria-label="' + t("Workspace tools", "工作区工具") + '"] button[aria-label="Excalidraw"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("uninstalled.png") });
    await management.getByRole("button", { name: t("Reinstall", "重新安装"), exact: true }).click();
    await expect(management).toContainText(t("Installed · Disabled", "已安装 · 未启用"));
    await management.getByRole("switch", { name: t("Enable Excalidraw", "启用 Excalidraw"), exact: true }).click();
    await expect(management.getByRole("switch")).toBeChecked();
    const currentSession = page.getByRole("button", { name: "Hosted test", exact: true });
    if (!await currentSession.isVisible()) await page.getByRole("button", { name: t("Expand sidebar", "展开侧栏"), exact: true }).click();
    await currentSession.click();
    await expect(page.frameLocator('iframe[title="Excalidraw tool"]').getByRole("img")).toBeVisible();
    expect((await h.action("get", { id: created.id })).scene.elements).toEqual(checkpoint);
    await expect(page.locator('[role="tab"]').filter({ hasText: "Excalidraw" })).toHaveCount(0);
    const restoredEntry = page.locator('[aria-label="' + t("Workspace tools", "工作区工具") + '"] button[aria-label="Excalidraw"]');
    await expect(restoredEntry).toHaveCount(1);
    expect(await restoredEntry.locator("svg").innerHTML()).toBe(workspaceIcon);
    expect(h.errors).toEqual([]);
  } finally {
    if (lost) await h.integration.handlers.views({ ...lost, operation: "discard", confirmation: "discard-unconfirmed-edits" });
    await h.close();
  }
});
