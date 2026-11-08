/** Opt-in real-UI README capture of the OpenPencil plugin. Real host, plugin worker and editor; the model
 * turn is scripted (no provider or registry calls). Needs a built plugin (PI_PENCIL_ROOT, see the helper).
 * CAPTURE_README_PENCIL=1 npx playwright test test/browser/readme-pencil.spec.ts --workers=1
 */
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pencilBuilt, pencilHost } from "../helpers/hosted-pencil.ts";

const font = (size: number, style: "Regular" | "Medium" | "Bold" = "Regular") => ({ family: "Inter", style, size });
const text = (ref: string, parent: string, content: string, size: number, color: string, style?: "Regular" | "Medium" | "Bold", extra: Record<string, unknown> = {}) =>
  ({ op: "create", ref, parent, type: "TEXT", props: { name: content.slice(0, 40), ...extra, text: { content, font: font(size, style), color } } });
const field = (ref: string, parent: string, label: string, value: string) => [
  { op: "create", ref: `${ref}Group`, parent, type: "FRAME", props: { name: `${label} field`, sizingH: "FILL", layout: { mode: "VERTICAL", gap: 8 } } },
  text(`${ref}Label`, `${ref}Group`, label, 14, "#374151", "Medium"),
  { op: "create", ref, parent: `${ref}Group`, type: "FRAME", props: { name: `${label} input`, sizingH: "FILL", fill: "#F9FAFB", radius: 12, stroke: { color: "#E5E7EB", weight: 1, align: "INSIDE" }, layout: { mode: "HORIZONTAL", align: "CENTER", padding: { top: 14, right: 16, bottom: 14, left: 16 } } } },
  text(`${ref}Value`, ref, value, 16, "#6B7280"),
];
const stat = (ref: string, parent: string, label: string, value: string, delta: string) => [
  { op: "create", ref, parent, type: "FRAME", props: { name: label, sizingH: "FILL", fill: "#FFFFFF", radius: 16, stroke: { color: "#E5E7EB", weight: 1, align: "INSIDE" }, layout: { mode: "VERTICAL", gap: 6, padding: { top: 16, right: 16, bottom: 16, left: 16 } } } },
  text(`${ref}L`, ref, label, 13, "#6B7280", "Medium"),
  text(`${ref}V`, ref, value, 24, "#111827", "Bold"),
  text(`${ref}D`, ref, delta, 13, "#059669", "Medium"),
];
const row = (ref: string, parent: string, title: string, meta: string, amount: string, dot: string) => [
  { op: "create", ref, parent, type: "FRAME", props: { name: title, sizingH: "FILL", layout: { mode: "HORIZONTAL", gap: 12, align: "CENTER", padding: { top: 12, bottom: 12 } } } },
  { op: "create", ref: `${ref}Dot`, parent: ref, type: "ELLIPSE", props: { name: "Icon", width: 40, height: 40, fill: dot } },
  { op: "create", ref: `${ref}Text`, parent: ref, type: "FRAME", props: { name: "Text", sizingH: "FILL", layout: { mode: "VERTICAL", gap: 2 } } },
  text(`${ref}T`, `${ref}Text`, title, 15, "#111827", "Medium"),
  text(`${ref}M`, `${ref}Text`, meta, 13, "#6B7280"),
  text(`${ref}A`, ref, amount, 15, "#111827", "Bold"),
];
const OPS = [
  // Sign-in screen.
  { op: "create", ref: "$signin", parent: "$page", type: "FRAME", props: { name: "Sign in", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", layout: { mode: "VERTICAL", gap: 24, padding: { top: 96, right: 24, bottom: 32, left: 24 } } } },
  { op: "create", ref: "$logo", parent: "$signin", type: "RECTANGLE", props: { name: "Logo", width: 48, height: 48, radius: 14, fill: "#4F46E5" } },
  { op: "create", ref: "$heading", parent: "$signin", type: "FRAME", props: { name: "Heading", sizingH: "FILL", layout: { mode: "VERTICAL", gap: 8 } } },
  text("$h1", "$heading", "Welcome back", 30, "#111827", "Bold"),
  text("$h2", "$heading", "Sign in to keep your projects in sync.", 16, "#6B7280"),
  ...field("$email", "$signin", "Email", "ada@example.com"),
  ...field("$password", "$signin", "Password", "••••••••••"),
  text("$forgot", "$signin", "Forgot password?", 14, "#4F46E5", "Medium"),
  { op: "create", ref: "$cta", parent: "$signin", type: "FRAME", props: { name: "Primary button", sizingH: "FILL", fill: "#4F46E5", radius: 12, layout: { mode: "HORIZONTAL", justify: "CENTER", align: "CENTER", padding: { top: 16, bottom: 16 } } } },
  text("$ctaText", "$cta", "Sign in", 16, "#FFFFFF", "Bold"),
  text("$signup", "$signin", "New here? Create an account", 14, "#6B7280"),
  // Dashboard screen.
  { op: "create", ref: "$home", parent: "$page", type: "FRAME", props: { name: "Dashboard", x: 470, y: 0, width: 390, height: 844, fill: "#F3F4F6", layout: { mode: "VERTICAL", gap: 20, padding: { top: 64, right: 20, bottom: 32, left: 20 } } } },
  text("$hello", "$home", "Good morning, Ada", 24, "#111827", "Bold"),
  { op: "create", ref: "$stats", parent: "$home", type: "FRAME", props: { name: "Stats", sizingH: "FILL", layout: { mode: "HORIZONTAL", gap: 12 } } },
  ...stat("$s1", "$stats", "Balance", "$4,280", "+12% this month"),
  ...stat("$s2", "$stats", "Savings", "$1,150", "+$240"),
  { op: "create", ref: "$list", parent: "$home", type: "FRAME", props: { name: "Recent activity", sizingH: "FILL", fill: "#FFFFFF", radius: 16, layout: { mode: "VERTICAL", gap: 0, padding: { top: 16, right: 16, bottom: 8, left: 16 } } } },
  text("$listTitle", "$list", "Recent activity", 16, "#111827", "Bold"),
  ...row("$r1", "$list", "Design review", "Today · Studio", "−$48", "#E0E7FF"),
  ...row("$r2", "$list", "Client payment", "Yesterday · Invoice #102", "+$1,200", "#D1FAE5"),
  ...row("$r3", "$list", "Cloud storage", "Mon · Subscription", "−$9", "#FEF3C7"),
];

test.use({ deviceScaleFactor: 1.5 });

test("capture the OpenPencil plugin for README", async ({ page }) => {
  test.skip(process.env.CAPTURE_README_PENCIL !== "1" || !pencilBuilt, "Opt-in documentation capture with a built OpenPencil plugin");
  test.setTimeout(150_000);
  const h = await pencilHost(page, { sessionName: "Mobile banking app" });
  const output = fileURLToPath(new URL("../../assets/readme/", import.meta.url));
  try {
    await mkdir(output, { recursive: true });
    await h.manage("install"); await h.manage("enable");
    await expect.poll(async () => (await h.devState()).state, { timeout: 30_000 }).toBe("synced");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(h.bridge.url);
    await page.getByRole("button", { name: "Open right sidebar" }).click();
    await page.getByRole("button", { name: "OpenPencil", exact: true }).click();
    const ws = page.frameLocator('iframe[title="OpenPencil workspace"]');
    await expect(ws.getByTestId("toolbar")).toBeVisible({ timeout: 20_000 });
    // Give the canvas room: collapse the navigation and widen the tool panel (short of the focus snap).
    await page.getByRole("button", { name: "Collapse sidebar" }).first().click();
    const edge = (await page.locator('iframe[title="OpenPencil workspace"]').boundingBox())!.x;
    await page.mouse.move(edge - 1, 450); await page.mouse.down();
    await page.mouse.move(edge - 220, 450, { steps: 8 }); await page.mouse.up();

    const applied = await h.agent("pencil_apply_changes", { title: "Sign-in and dashboard screens", ops: OPS }, {
      prompt: "Design two mobile screens for a personal finance app: a sign-in screen, and a dashboard with balance, savings and recent activity.",
      reply: "Added two 390 × 844 screens on the OpenPencil canvas: **Sign in** (email, password, primary button) and **Dashboard** (two stat cards and a recent-activity list). They use auto layout and an 8-pt spacing scale. Undo from the toast if you'd like a different direction.",
    });
    expect(applied.status).toBe("applied");
    await expect(ws.getByTestId("agent-toast")).toContainText("Sign-in and dashboard screens", { timeout: 15_000 });
    await ws.locator("body").evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500); // let CanvasKit finish the zoom-to-selection frame
    await page.screenshot({ path: `${output}openpencil.png`, animations: "disabled" });
    expect(h.errors).toEqual([]);
    expect(h.external).toEqual([]);
  } catch (error) {
    await h.close().catch(() => {});
    throw error;
  }
  await h.close();
});
