import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalHost } from "../helpers/terminal-host.ts";
import { startBridge } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { DIAGRAM_PLUGIN, type DiagramDraft, type DiagramGraph } from "../../src/plugins/builtin/diagrams/contract/diagrams.ts";

const samples: [string, string[], [number, number, string?][], DiagramGraph["layout"]?][] = [
  ["验证码登录", ["输入验证码", "验证通过？", "登录成功"], [[0, 1], [1, 2, "是"], [1, 0, "否，重试"]]],
  ["支付异常", ["创建订单", "支付成功？", "发货", "重试付款"], [[0, 1], [1, 2, "成功"], [1, 3, "失败"], [3, 1]]],
  ["三层服务", ["浏览器", "API 网关", "业务服务", "数据库"], [[0, 1], [1, 2], [2, 3]], "left-right"],
  ["缓存读取", ["查询数据", "命中缓存？", "返回缓存", "查询数据库", "写入缓存"], [[0, 1], [1, 2, "命中"], [1, 3, "未命中"], [3, 4]]],
  ["审批流程", ["提交申请", "经理审批", "财务复核", "批准", "退回修改"], [[0, 1], [1, 2], [2, 3, "通过"], [1, 4, "退回"]]],
  ["文件上传", ["选择文件", "格式正确？", "上传文件", "提示错误"], [[0, 1], [1, 2, "是"], [1, 3, "否"]]],
  ["注册验证", ["填写信息", "邮箱验证", "创建账号", "欢迎页面"], [[0, 1], [1, 2], [2, 3]]],
  ["发布流水线", ["代码提交", "自动测试", "构建产物", "测试环境", "人工确认", "生产发布"], [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]], "left-right"],
  ["事件驱动架构", ["生产者", "消息队列", "消费者甲", "消费者乙", "数据存储"], [[0, 1], [1, 2], [1, 3], [2, 4], [3, 4]], "left-right"],
  ["退款流程", ["提交退款", "符合条件？", "原路退款", "发送通知", "拒绝退款"], [[0, 1], [1, 2, "是"], [2, 3], [1, 4, "否"]]],
];

test("ten fixed Chinese structures preserve labels, bindings and non-overlapping nodes; cold 30-node canvas is measured", async ({ page }, info) => {
  test.setTimeout(90_000); page.setDefaultTimeout(10000);
  const cwd = await mkdtemp(join(tmpdir(), "pi-diagram-samples-"));
  const { host } = terminalHost(cwd);
  const bridge = await startBridge(host, new URL("../../web/dist", import.meta.url).pathname, new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }), { pluginSettingsFile: join(cwd, "plugins.json") });
  const url = new URL(bridge.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" };
  const get = async (id: string): Promise<DiagramDraft> => fetch(url.origin + "/api/diagrams/get", { method: "POST", headers, body: JSON.stringify({ sessionId: "terminal-a", id }) }).then(r => r.json());
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); });
  const panel = page.locator("[data-sidebar-right-session]");
  const metrics: object[] = [];
  try {
    await page.goto(bridge.url); await page.getByRole("button", { name: "Open right sidebar", exact: true }).click();
    await panel.getByRole("button", { name: "Diagrams", exact: true }).click();
    const thirty: DiagramGraph = { nodes: Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `处理节点 ${i + 1}` })), edges: Array.from({ length: 29 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}` })) };
    const fixtures = [["三十节点性能基线", thirty] as const, ...samples.map(([title, labels, edges, layout]) => [title, { nodes: labels.map((label, i) => ({ id: `n${i}`, label, kind: label.includes("？") ? "decision" as const : "process" as const })), edges: edges.map(([from, to, label], i) => ({ id: `e${i}`, from: `n${from}`, to: `n${to}`, ...(label ? { label } : {}) })), layout }] as const)];
    for (const [title, graph] of fixtures) {
      const created = await bridge.runPluginTool(DIAGRAM_PLUGIN, cwd, "terminal-a", "create", { title, graph }) as { id: string };
      const entry = panel.getByRole("button", { name: new RegExp(title) }); await expect(entry).toBeVisible();
      const started = Date.now(); await entry.click();
      await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toBeEnabled();
      await expect(panel.locator(".excalidraw canvas.interactive")).toBeVisible();
      metrics.push({ title, openToInteractiveMs: Date.now() - started, nodes: graph.nodes.length });
      await panel.getByRole("button", { name: "Accept candidate", exact: true }).click();
      await expect.poll(async () => !!(await get(created.id)).candidate).toBe(false);
      const scene = (await get(created.id)).scene;
      for (const n of graph.nodes) { expect(scene.elements.some(e => e.id === n.id)).toBe(true); expect(scene.elements.some(e => e.text === n.label && e.containerId === n.id)).toBe(true); }
      for (const edge of graph.edges) {
        const e = scene.elements.find(e => e.id === edge.id)!;
        expect(e.type).toBe("arrow"); expect(e.startBinding).toMatchObject({ elementId: edge.from }); expect(e.endBinding).toMatchObject({ elementId: edge.to });
        const points = e.points as number[][]; expect(points.length).toBeGreaterThanOrEqual(2);
        expect(Math.hypot(points.at(-1)![0]!, points.at(-1)![1]!)).toBeGreaterThan(20);
        if (edge.label) expect(scene.elements.some(e => e.containerId === edge.id && e.text === edge.label)).toBe(true);
      }
      const nodes = scene.elements.filter(e => graph.nodes.some(n => n.id === e.id));
      for (let i = 0; i < nodes.length; i++) for (const b of nodes.slice(i + 1)) { const a = nodes[i]!; expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true); }
      await expect(panel.getByRole("button", { name: "Accept candidate", exact: true })).toHaveCount(0);
      if (title !== "三十节点性能基线") await page.screenshot({ path: info.outputPath(`${title}.png`) });
      await panel.getByRole("button", { name: "New tab", exact: true }).click();
      await panel.getByRole("button", { name: "Diagrams", exact: true }).click();
      await expect(panel.locator("[data-diagram-canvas] .excalidraw")).toHaveCount(0);
    }
    const assets = await page.evaluate(() => performance.getEntriesByType("resource").filter(e => e.name.includes("/assets/")).map(e => ({ url: new URL(e.name).pathname, bytes: (e as PerformanceResourceTiming).decodedBodySize, transferred: (e as PerformanceResourceTiming).transferSize })));
    await info.attach("canvas-measurements", { body: JSON.stringify({ browser: await page.context().browser()?.version(), metrics, assets }, null, 2), contentType: "application/json" });
    expect((metrics[0] as { openToInteractiveMs: number }).openToInteractiveMs).toBeLessThan(3000);
  } finally { await page.close(); await bridge.close(); await rm(cwd, { recursive: true, force: true }); }
});
