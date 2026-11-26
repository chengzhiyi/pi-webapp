import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { projectEntry } from "../../src/host/server/sessions/view.ts";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

test("subagent notifications stay compact in chat and show their result preview in the trajectory", async ({ page }) => {
  const { host, switchSession } = terminalHost();
  const session = switchSession("subagent-notice");
  const timestamp = "2026-01-01T00:00:00.000Z";
  session.messages = [
    { id: "user", role: "user", timestamp, blocks: [{ kind: "text", text: "Check the browser integration" }] },
    { id: "other", role: "notice", timestamp, blocks: [{ kind: "text", text: "An ordinary notice" }] },
  ];
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  try {
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "zh"));
    await page.goto(bridge.url);
    await expect(page.getByText("An ordinary notice", { exact: true })).toBeVisible();

    const entry = { type: "custom_message", customType: "subagent-notification", id: "subagent", timestamp,
      parentId: "other", display: true,
      content: "<task-notification><output-file>/tmp/agent-transcript.log</output-file><result>Reuse the workbench.</result></task-notification>",
      details: { status: "completed", description: "定位桌面浏览器接入点", resultPreview: "**Reuse the workbench.**" },
    } as const;
    session.messages = [...session.messages, projectEntry(entry)!,
      { id: "answer", role: "assistant", timestamp, blocks: [{ kind: "text", text: "Here is the final reply." }] }];
    bridge.publish({ type: "snapshot", session });

    const summary = page.locator('[data-message-role="notice"]').filter({ hasText: "子代理已完成：定位桌面浏览器接入点" });
    await expect(summary).toHaveText("子代理已完成：定位桌面浏览器接入点");
    await expect(page.getByText("Here is the final reply.", { exact: true })).toBeVisible();
    await expect(page.getByText(/<task-notification>|agent-transcript\.log|Reuse the workbench/)).toHaveCount(0);

    await page.reload();
    await expect(summary).toBeVisible();
    await page.getByRole("tab", { name: "轨迹" }).click();
    await page.getByRole("row", { name: /子代理已完成：定位桌面浏览器接入点/ }).click();
    const details = page.getByRole("complementary", { name: "轨迹详情" });
    await expect(details.locator("strong")).toHaveText("Reuse the workbench.");
    await expect(details.getByText(/<task-notification>|agent-transcript\.log/)).toHaveCount(0);
  } finally {
    await bridge.close();
  }
});
