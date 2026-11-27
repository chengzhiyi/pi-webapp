import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { ViewMessage, WorkspaceListView } from "../../src/contracts/bridge-contract.ts";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

test("subtasks stay grouped, reopen from links and parent trajectory, and preserve the parent draft", async ({ page }) => {
  const { host, switchSession } = terminalHost();
  const session = switchSession("parent");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const user = (id: string, text: string, subagentInput?: ViewMessage["subagentInput"]): ViewMessage => ({ id, role: "user", timestamp, blocks: [{ kind: "text", text }], subagentInput });
  session.name = "Browser preview";
  session.messages = [user("request", "Implement the browser preview"), { id: "spawn", role: "assistant", timestamp, blocks: [{ kind: "toolCall", toolName: "Agent", toolCallId: "agent-call", text: '{"prompt":"Write a test"}' }] }];
  const row = { workspaceId: "workspace", path: null, modified: timestamp, idle: true };
  const agent = { parentSessionId: "parent", agentId: "9b9f05c9-8d12-423", agentType: "general-purpose", description: "Acceptance coverage", dispatchCallId: "agent-call", status: "completed" } as const;
  const workspace: WorkspaceListView = { activeId: "workspace", items: [{ id: "workspace", path: session.cwd, title: "Preview project" }], sessions: [
    { ...row, id: "child", name: "general-purpose#9b9f05c9", subagent: agent },
    { ...row, id: "parent", name: session.name },
    { ...row, id: "fork", name: "Independent fork" },
    { ...row, id: "orphan", name: "Explore#9b9f05c9", subagent: { ...agent, parentSessionId: null, description: "Old exploration", status: "unknown" } },
  ] };
  host.workspaces = async () => workspace;
  host.subagentHistory = async (workspaceId, id) => workspaceId === "workspace" && (id === "child" || id === "orphan") ? [
    user("dispatch", "Develop an acceptance test", "dispatch"), user("steer", "Use the preview branch", "steering"),
    { id: "result", role: "assistant", timestamp, blocks: [{ kind: "text", text: "Coverage added." }] },
  ] : null;
  let liveSwitches = 0;
  host.selectSession = async () => { liveSwitches += 1; };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.goto(bridge.url);
    const entry = page.getByRole("button", { name: "Acceptance coverage", exact: true });
    const toggle = page.getByRole("button", { name: "Subtasks for Browser preview", exact: true });
    const parent = page.getByRole("button", { name: "Browser preview", exact: true });
    const composer = page.getByRole("textbox");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText(/^\d+ subtasks?$/)).toHaveCount(0);
    const parentBounds = (await parent.boundingBox())!;
    const toggleBounds = (await toggle.boundingBox())!;
    expect(toggleBounds.y).toBe(parentBounds.y);
    expect(toggleBounds.height).toBe(parentBounds.height);
    expect(toggleBounds.width).toBeLessThan(parentBounds.width);
    await expect(entry).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Independent fork", exact: true })).toBeVisible();
    await composer.fill("Unsent parent draft");
    await toggle.click();
    await expect(entry).toBeVisible();
    await toggle.click();
    await expect(entry).toHaveCount(0);
    await expect(parent).toHaveAttribute("aria-current", "page");
    await toggle.click();
    await entry.click();
    await expect(page).toHaveURL(/subagent=child/);
    await expect(entry).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Parent agent dispatch", { exact: true })).toBeVisible();
    await expect(page.getByText("Parent agent steering", { exact: true })).toBeVisible();
    await expect(page.getByText("Result", { exact: true })).toBeVisible();
    await expect(composer).toHaveCount(0);
    await toggle.click();
    await expect(entry).toHaveCount(0);
    await expect(page.getByText("Parent agent dispatch", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Back to parent conversation/ }).click();
    await expect(composer).toHaveText("Unsent parent draft");
    await page.getByRole("tab", { name: "Trajectory" }).click();
    await page.getByRole("row", { name: /Tool.*Write a test/ }).click();
    await page.getByRole("button", { name: /View subtask.*Acceptance coverage/ }).click();
    await page.reload();
    await expect(entry).toHaveAttribute("aria-current", "page");
    await page.getByRole("tab", { name: "Trajectory" }).click();
    await expect(page.getByRole("row", { name: /Parent agent steering/ })).toBeVisible();
    await page.getByRole("button", { name: /Back to parent conversation/ }).click();
    await page.getByRole("button", { name: "Search workspaces and sessions" }).click();
    await page.getByRole("searchbox", { name: "Search by name or workspace path" }).fill("Acceptance coverage");
    await expect(entry).toBeVisible();
    await page.getByRole("button", { name: "Close search" }).click();
    await page.getByRole("button", { name: "Unlinked subtasks" }).click();
    await page.getByRole("button", { name: "Old exploration" }).click();
    await expect(page.getByRole("button", { name: /Back to conversation/ })).toBeVisible();
    expect(liveSwitches).toBe(0);
  } finally { await bridge.close(); }
});
