import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostedPluginCard, HostedViewInput } from "../../src/contracts/hosted-plugins.ts";
import { HostedViewCoordinator } from "../../src/host/server/plugins/hosted/views.ts";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { emptyHosted } from "../helpers/empty-hosted.ts";
import { terminalHost } from "../helpers/terminal-host.ts";

test("closing Files ignores a busy drawing; closing the floating drawing needs its own ACK", async ({ page }) => {
  page.setDefaultTimeout(5_000);
  const directory = await mkdtemp(join(tmpdir(), "pi-hosted-tab-close-"));
  const { host } = terminalHost(directory);
  const card: HostedPluginCard = { pluginId: "test-drawing", name: "Test drawing", official: false, installed: true, enabled: true, generation: 1, phase: "active", documentUrl: "/tab-close-fixture.html", controllerUrl: "/tab-close-fixture.html", contribution: {
    entry: { label: "Test drawing", kind: "workspace", description: { zh: "绘图测试", en: "Drawing fixture" } }, panels: ["workspace"], artifactTools: [], toolViews: [], panelAlias: { prefix: "test-drawing:", kind: "workspace", title: "Test drawing" },
  } };
  const scope = { ownerId: "test", workspaceId: "test", sessionId: "terminal-a" };
  const coordinator = new HostedViewCoordinator(card.pluginId, 1);
  const writes: HostedViewInput[] = [];
  host.hosted = { ...emptyHosted, inventory: async () => ({ plugins: [card] }), views: async body => {
    const input = body as unknown as HostedViewInput;
    const reply = await coordinator.handle(input, scope);
    if (input.operation === "change" || input.operation === "close") writes.push(input);
    return reply;
  } };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, "plugins.json") });
  try {
    // Fail both a legacy session-wide flush and the drawing's real freeze while busy.
    await page.route("**/tab-close-fixture.html?*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><textarea aria-label="Draft" disabled></textarea><button>Finish drawing gesture</button><script>
      const draft = document.querySelector('textarea');
      let busy = false;
      document.querySelector('button').onclick = () => { busy = false; };
      addEventListener('message', ({data, ports}) => {
        if (data?.type !== 'pi:hosted:connect') return;
        const [port] = ports;
        let initializeId;
        const reply = (id, ok) => port.postMessage({type: 'response', id, ok, error: ok ? undefined : {message:'Drawing gesture still in progress'}});
        port.onmessage = ({data}) => {
          if (data.type === 'response' && data.id === 'dirty' && data.ok) {
            draft.disabled = false; reply(initializeId, true); return;
          }
          if (data.type !== 'request') return;
          if (data.method === 'initialize' && data.input.kind !== 'controller') {
            busy = true;
            initializeId = data.id;
            port.postMessage({type:'request', id:'dirty', method:'changed', input:{dirty:true, busy:true}}); return;
          }
          reply(data.id, !busy || !['freeze', 'flush'].includes(data.method));
        };
      });
    </script>` }));
    await page.addInitScript(() => localStorage.setItem("pi-web-locale", "en"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(bridge.url);
    await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    const panel = page.locator("[data-sidebar-right-session]");
    await panel.getByRole("button", { name: "Test drawing", exact: true }).click();
    const frame = panel.frameLocator('iframe[title="Test drawing workspace"]');
    const draft = frame.getByRole("textbox", { name: "Draft" });
    await draft.fill("unsaved drawing");
    await panel.getByRole("button", { name: "New tab", exact: true }).click();
    await panel.getByRole("button", { name: "Workspace files", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 850 });
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "fullscreen");
    const files = panel.getByRole("tab", { name: /^Files(?: Close)?$/ });
    await expect(files).toBeVisible();
    await files.getByRole("button", { name: "Close", exact: true }).click();
    await expect(files).toHaveCount(0);
    await expect(draft).toHaveValue("unsaved drawing");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(panel).toHaveAttribute("data-sidebar-right-panel", "push");
    const tab = panel.getByRole("tab", { name: /^Test drawing(?: Close)?$/ });
    const { x, y, width, height } = (await tab.boundingBox())!;
    await page.mouse.move(x + width / 2, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(500, 200, { steps: 10 });
    await page.mouse.up();
    const floating = panel.locator("[data-dockkit-float]");
    const close = floating.getByRole("button", { name: "Close", exact: true });
    await close.click();
    await expect(page.getByText("Drawing gesture still in progress", { exact: true })).toBeVisible();
    await expect(draft).toHaveValue("unsaved drawing");
    expect(writes.map(input => input.operation === "change" ? [input.dirty, input.busy] : input.operation)).toEqual([[true, true]]);
    await frame.getByRole("button", { name: "Finish drawing gesture" }).click();
    await close.click();
    await expect(floating).toHaveCount(0);
    expect(writes.map(input => input.operation === "change" ? [input.dirty, input.busy] : input.operation)).toEqual([[true, true], [false, false], "close"]);
  } finally {
    try { if (!page.isClosed()) await page.goto("about:blank"); }
    finally { coordinator.dispose(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  }
});
