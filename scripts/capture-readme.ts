/** Rebuild web assets first, then run: node --experimental-strip-types scripts/capture-readme.ts
 * Captures the real UI with seeded demo messages and a disposable Git/terminal workspace.
 * No provider login, model requests, user sessions, or user repositories are accessed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { startBridge, type BridgeHost } from "../src/host/server/transport/bridge.ts";
import type { SessionView } from "../src/contracts/bridge-contract.ts";
import { NodeTelemetry } from "../src/platform/telemetry/telemetry.ts";

const output = fileURLToPath(new URL("../assets/readme/", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "pi-readme-demo-"));
const cwd = join(directory, "shop-demo");
await mkdir(cwd);
const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=Pi Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
const checkout = `export type Item = { price: number; quantity: number };

const shipping = 500;
const freeShippingAt = 5_000;

// Prices are integer cents; shipping is free from $50.
export function total(items: Item[]): number {
  const subtotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );

  return subtotal >= freeShippingAt
    ? subtotal
    : subtotal + shipping;
}
`;

await mkdir(output, { recursive: true });
await mkdir(join(cwd, "src"));
await mkdir(join(cwd, "test"));
await writeFile(join(cwd, "src", "checkout.ts"), checkout.replace(">= freeShippingAt", "> freeShippingAt"));
await writeFile(join(cwd, "README.md"), "# Shop demo\n\nA small checkout helper with integer-cent totals.\n");
await git("init", "-b", "main");
await git("add", ".");
await git("commit", "-m", "Add checkout helper");
await writeFile(join(cwd, "src", "checkout.ts"), checkout);
await writeFile(join(cwd, "test", "checkout.test.mjs"), `import assert from 'node:assert/strict';
import test from 'node:test';
import { total } from '../src/checkout.ts';

test('shipping is free at the $50 threshold', () => {
  assert.equal(total([{ price: 2500, quantity: 2 }]), 5000);
});
test('smaller orders include shipping', () => {
  assert.equal(total([{ price: 1200, quantity: 2 }]), 2900);
});
`);
await git("add", "test/checkout.test.mjs");

const timestamp = "2026-10-22T10:00:00.000Z";
const session: SessionView = {
  schemaVersion: 1, sessionId: "readme-demo", cwd, name: "Review checkout", model: "demo/model",
  thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"], idle: true,
  contextUsage: { tokens: 4200, contextWindow: 200000, percent: 2.1 }, pluginEntries: [],
  messages: [
    { id: "request", role: "user", timestamp, blocks: [{ kind: "text", text: "Review the checkout helper. Fix the free-shipping boundary and add regression tests." }] },
    { id: "response", role: "assistant", timestamp, blocks: [{ kind: "text", text: "### A small boundary, a real difference\n\nAn order of exactly **$50** should qualify for free shipping. The comparison was `>` instead of `>=`.\n\n- Updated [src/checkout.ts](src/checkout.ts) at the threshold.\n- Added [regression tests](test/checkout.test.mjs) for both sides of the boundary.\n- Kept all totals in integer cents.\n\nOpen the file to inspect the helper, review the Git diff, or run the tests in the terminal." }] },
  ],
};
const host: BridgeHost = {
  snapshot: () => session,
  models: () => [{ provider: "demo", id: "model", name: "Demo model" }],
  async providers() { return [{ id: "demo", name: "Demo provider", configured: true, storedCredential: false, methods: ["api_key"] }]; },
  send() { throw new Error("Screenshot fixtures do not call a model"); }, abort() {},
  async newSession() {}, async setModel() {}, async setThinkingLevel() {},
  config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
  async updateConfig() { return this.config(); },
  async workspaces() { return {
    items: [{ id: "shop", path: cwd, title: "Shop demo" }, { id: "docs", path: cwd, title: "Docs site" }], activeId: "shop",
    sessions: [{ id: "readme-demo", workspaceId: "shop", path: null, name: "Review checkout", modified: timestamp }, { id: "readme-layout", workspaceId: "shop", path: null, name: "Polish product cards", modified: timestamp }],
  }; },
  async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
};
// Use a clean, predictable shell prompt instead of the user's interactive profile.
const savedEnv = { SHELL: process.env.SHELL, ENV: process.env.ENV };
process.env.SHELL = "/bin/sh";
process.env.ENV = join(directory, ".demo-shell");
await writeFile(process.env.ENV, "PS1='demo $ '\nexport PS1\nexport NODE_NO_WARNINGS=1\n");
const bridge = await startBridge(host, fileURLToPath(new URL("../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(directory, ".plugins.json") });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 760 }, deviceScaleFactor: 1.5 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("pi-web-locale", "en");
    localStorage.setItem("pi-web-theme", "light");
  });
  await page.goto(bridge.url);
  await expect(page.getByRole("heading", { name: "A small boundary, a real difference" })).toBeVisible();
  await page.getByRole("link", { name: "src/checkout.ts", exact: true }).click();
  const panel = page.locator("[data-sidebar-right-session]");
  await expect(panel.locator("pre:visible")).toContainText("subtotal >= freeShippingAt");
  // Keep text legible: conversation and code share the remaining width.
  const resize = page.getByRole("separator", { name: /Resize right sidebar/ });
  if (await resize.count()) {
    const box = await resize.boundingBox();
    if (box) { await page.mouse.move(box.x + box.width / 2, 400); await page.mouse.down(); await page.mouse.move(750, 400, { steps: 12 }); await page.mouse.up(); }
  }
  const capture = async (name: string) => {
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    const target = name === "workbench.png" ? page : panel;
    await target.screenshot({ path: join(output, name), animations: "disabled" });
    console.log(`Captured assets/readme/${name}`);
  };
  await capture("workbench.png");

  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await panel.getByRole("button", { name: "Git changes", exact: true }).click();
  await panel.getByRole("button", { name: "src/checkout.ts, Modified", exact: true }).click();
  await expect(panel.getByRole("region", { name: "File diff", exact: true })).toContainText("+  return subtotal >= freeShippingAt");
  await capture("git-review.png");

  await panel.getByRole("button", { name: "New tab", exact: true }).click();
  await panel.getByRole("button", { name: "Open terminal", exact: true }).click();
  const terminal = panel.locator("[data-workspace-terminal]:visible");
  await expect(terminal).toHaveAttribute("data-terminal-phase", "connected");
  const input = terminal.locator("textarea");
  // Run actual tests in the disposable demo project, not a fabricated terminal transcript.
  await expect(terminal.locator(".xterm-rows")).toContainText("demo $");
  await input.fill("node --test test/*.test.mjs");
  await input.press("Enter");
  await expect(terminal.locator(".xterm-rows")).toContainText("pass 2");
  await expect(terminal.locator(".xterm-rows")).toContainText("fail 0");
  await capture("terminal.png");
  assert.deepEqual(errors, [], "Browser must render without JavaScript errors");
} finally {
  await browser?.close();
  await bridge.close();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(directory, { recursive: true, force: true });
}
