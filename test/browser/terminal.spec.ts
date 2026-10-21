import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

for (const width of [1440, 1024, 768, 390, 320]) test(`interactive terminal lifecycle at ${width}px`, async ({ page }, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-browser-"));
  const { host, switchSession } = terminalHost(cwd);
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    const expected = message.text().includes("net::ERR_INTERNET_DISCONNECTED")
      || (message.text().includes("409 (Conflict)") && /\/api\/terminal\/(input|resize)/.test(message.location().url));
    if (message.type() === "error" && !expected) errors.push(message.text());
  });
  let creations = 0;
  page.on("request", request => { if (request.url().endsWith("/api/terminal/create")) creations++; });
  await page.addInitScript((theme) => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", theme); }, width < 768 ? "dark" : "light");
  await page.setViewportSize({ width, height: 900 });
  const rightbar = page.locator("[data-sidebar-right-session]");
  const screen = page.locator("[data-workspace-terminal]:visible");
  const input = () => screen.locator("textarea");
  const command = async (text: string) => { await input().fill(text); await input().press("Enter"); };
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
    await expect(screen).toHaveAttribute("data-terminal-phase", "connected");
    await expect(screen.locator(".xterm-rows")).toHaveCSS("font-family", /monospace/);
    await expect(screen.locator(".xterm-rows")).toHaveCSS("white-space", "pre");
    await command("printf '%s' \"$PWD\" > terminal-cwd; printf '%s' \"$$\" > terminal-pid; export PI_TERMINAL_MARKER=retained");
    await expect.poll(async () => readFile(join(cwd, "terminal-cwd"), "utf8").catch(() => "")).toBe(cwd);
    const pid = Number(await readFile(join(cwd, "terminal-pid"), "utf8"));
    await command("printf '\\n终端运行成功 · Terminal ready\\n'");
    await expect(screen.locator(".xterm-rows")).toContainText("终端运行成功");
    await command("for i in 1 2 3; do printf '\\nSTREAM_%s\\n' \"$i\"; sleep 0.05; done");
    await expect(screen.locator(".xterm-rows")).toContainText("STREAM_3");
    await command("sleep 30");
    await expect.poll(() => { try { return execFileSync("pgrep", ["-P", String(pid), "-f", "sleep 30"], { encoding: "utf8" }).trim(); } catch { return ""; } }).not.toBe("");
    await input().press("Control+c");
    await expect.poll(() => { try { return execFileSync("pgrep", ["-P", String(pid), "-f", "sleep 30"], { encoding: "utf8" }).trim(); } catch { return ""; } }).toBe("");
    await command("printf '%s' interrupted > terminal-interrupted");
    await expect.poll(async () => readFile(join(cwd, "terminal-interrupted"), "utf8").catch(() => "")).toBe("interrupted");
    await rightbar.getByRole("button", { name: "New tab", exact: true }).click();
    await rightbar.getByRole("button", { name: "Workspace files", exact: true }).click();
    await rightbar.getByRole("treeitem", { name: "terminal-cwd", exact: true }).click();
    await expect(rightbar.locator("pre:visible")).toContainText(cwd);
    await rightbar.getByRole("tab", { name: /Terminal/ }).click({ position: { x: 15, y: 14 } });
    await expect(screen).toBeVisible();
    await rightbar.getByRole("button", { name: "Collapse right sidebar", exact: true }).click();
    bridge.publish({ type: "snapshot", session: switchSession("terminal-b") });
    await expect(rightbar).toHaveAttribute("data-sidebar-right-session", "terminal-b");
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await expect(rightbar.getByRole("button", { name: "Open terminal", exact: true })).toBeVisible();
    bridge.publish({ type: "snapshot", session: switchSession("terminal-a") });
    await expect(rightbar).toHaveAttribute("data-sidebar-right-session", "terminal-a");
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await expect(screen).toHaveAttribute("data-terminal-phase", "connected");
    await command("printf '%s:%s' \"$$\" \"$PI_TERMINAL_MARKER\" > terminal-retained");
    await expect.poll(async () => readFile(join(cwd, "terminal-retained"), "utf8").catch(() => "")).toBe(`${pid}:retained`);
    expect(creations).toBe(1);
    if (width === 1440) {
      await page.context().setOffline(true);
      await expect(screen).toHaveAttribute("data-terminal-phase", "disconnected");
      await page.context().setOffline(false);
      await expect(screen).toHaveAttribute("data-terminal-phase", "connected");
      await command("printf '%s:%s' \"$$\" \"$PI_TERMINAL_MARKER\" > terminal-reconnected");
      await expect.poll(async () => readFile(join(cwd, "terminal-reconnected"), "utf8").catch(() => "")).toBe(`${pid}:retained`);
      expect(creations).toBe(1);
    }
    if (width >= 768) {
      await rightbar.getByRole("button", { name: "Fullscreen", exact: true }).click();
      await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
      await command("stty size > terminal-size");
      await expect.poll(async () => readFile(join(cwd, "terminal-size"), "utf8").catch(() => "")).toMatch(/\d+ \d+/);
      const fullscreenSize = await readFile(join(cwd, "terminal-size"), "utf8");
      await rightbar.getByRole("button", { name: "Exit fullscreen", exact: true }).click();
      await expect(rightbar).toHaveAttribute("data-sidebar-right-panel", "push");
      await expect.poll(async () => { await command("stty size > terminal-size"); return readFile(join(cwd, "terminal-size"), "utf8"); }).not.toBe(fullscreenSize);
    }
    if (width === 1440) {
      await rightbar.getByRole("button", { name: "Split", exact: true }).click();
      await rightbar.getByRole("button", { name: "Open terminal", exact: true }).click();
      await expect(screen).toHaveCount(2);
      await expect(screen.nth(1)).toHaveAttribute("data-terminal-phase", "connected");
      await page.screenshot({ path: testInfo.outputPath("terminal-split.png") });
      const pane = rightbar.locator('[data-dockkit-pane][data-dockkit-column="1"]');
      await pane.getByRole("button", { name: "Close", exact: true }).click();
      await expect(screen).toHaveCount(1);
      await expect(rightbar.locator("[data-dockkit-pane]")).toHaveCount(1);
      await expect.poll(async () => (await screen.locator(".xterm-screen").boundingBox())!.width / (await screen.boundingBox())!.width).toBeGreaterThan(0.85);
    }
    await page.screenshot({ path: testInfo.outputPath(`terminal-${width}.png`) });
    await command("exit 7");
    await expect(screen).toHaveAttribute("data-terminal-phase", "exited");
    await expect(screen.getByRole("status")).toContainText("Process exited (7)");
    await screen.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(screen).toHaveAttribute("data-terminal-phase", "connected");
    await command("printf '%s' \"$$\" > terminal-close-pid");
    await expect.poll(async () => Number(await readFile(join(cwd, "terminal-close-pid"), "utf8").catch(() => ""))).toBeGreaterThan(0);
    const closePid = Number(await readFile(join(cwd, "terminal-close-pid"), "utf8"));
    const selectedTab = rightbar.getByRole("tab", { selected: true });
    await selectedTab.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => { try { process.kill(closePid, 0); return true; } catch { return false; } }).toBe(false);
    expect(errors).toEqual([]);
  } finally { await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("failed shell startup is reviewable and service shutdown reaps the live terminal", async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-terminal-failure-"));
  const { host, switchSession } = terminalHost(cwd);
  switchSession("terminal-a", join(cwd, "missing"));
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  let closed = false;
  let creations = 0;
  page.on("request", request => { if (request.url().endsWith("/api/terminal/create")) creations++; });
  await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
  try {
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Open terminal", exact: true }).click();
    const terminal = page.locator("[data-workspace-terminal]:visible");
    await expect(terminal).toHaveAttribute("data-terminal-phase", "failed");
    await expect(terminal.getByRole("status")).toContainText("the workspace directory is missing or inaccessible");
    bridge.publish({ type: "snapshot", session: switchSession("terminal-a", cwd) });
    await terminal.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(terminal).toHaveAttribute("data-terminal-phase", "connected");
    await terminal.locator("textarea").fill("printf '%s' \"$$\" > pid");
    await terminal.locator("textarea").press("Enter");
    await expect.poll(async () => Number(await readFile(join(cwd, "pid"), "utf8").catch(() => ""))).toBeGreaterThan(0);
    const pid = Number(await readFile(join(cwd, "pid"), "utf8"));
    await bridge.close(); closed = true;
    await expect(terminal).toHaveAttribute("data-terminal-phase", "disconnected");
    expect(() => process.kill(pid, 0)).toThrow();
    expect(creations).toBe(2);
  } finally { if (!closed) await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
