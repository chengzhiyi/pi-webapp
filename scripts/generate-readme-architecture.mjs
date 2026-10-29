import { writeFile } from "node:fs/promises";

// Shared geometry keeps both README diagrams in sync. No renderer or remote assets.
const copy = {
  en: {
    title: "One workbench. A complete Agent workflow.",
    subtitle: "Shared UI · Local-first host · Typed contracts · Pluggable capabilities",
    description: "Browser and Electron share a React workbench. HTTP actions and NDJSON events connect it to a local Node host, which orchestrates Pi sessions and plugins. Pi SDK, model providers and local tools supply execution. Contracts, optional hosted extensions and diagnostics are shown alongside the main layers.",
    ui: "01  Interaction layer",
    entry: ["Browser / Electron", "One React interface"],
    workbench: ["React + TypeScript workbench", "Chat · Sessions · Dock panels · Settings"],
    pluginUI: ["Plugin views", "Built-in panels / Extension UI"],
    transport: "Transport     HTTP actions / NDJSON events · Bearer + Origin checks",
    host: "02  Local Node host",
    orchestration: ["Application orchestration & lifecycle", "Sessions / Workspaces / Model auth / Attachments"],
    registry: ["Plugin registration & runtime management", "Files · Git · Terminal / Hosted extensions"],
    hostNote: "Thin Pi adapter · Foreground / background sessions · Plugin switches & cleanup",
    runtime: "03  Execution & external capabilities",
    pi: ["Pi SDK · AgentSession"],
    models: ["Model providers · APIs"],
    tools: ["Filesystem · Git · PTY / Processes"],
    contracts: "Typed contracts",
    contractBody: ["Wire DTOs", "Event validation", "Plugin / Workbench API", "", "Browser code never imports", "Node / Pi runtime objects"],
    extensions: "Optional extensions",
    extensionBody: ["Hosted plugin runtime", "Separate Node process", "", "Official Excalidraw plugin", "Opt-in, not built in"],
    support: "Cross-cutting support",
    supportBody: ["Sentry · Diagnostics", "CLI / Desktop launch & updates"],
    footer: "A local modular host, not a microservice cluster. Peers within a layer do not imply sequential calls.",
    source: "Source: src/host · src/plugins/builtin · src/contracts · web · desktop",
  },
  zh: {
    title: "一个工作台，连接完整的 Agent 工作流",
    subtitle: "共享界面 · 本地优先 · 契约解耦 · 插件化扩展",
    description: "浏览器与 Electron 复用 React 工作台，经 HTTP 动作和 NDJSON 事件连接本地 Node 宿主。宿主编排 Pi 会话与插件，由 Pi SDK、模型服务和本地工具提供执行能力。跨端契约、可选 Hosted 扩展与诊断支撑并列展示。",
    ui: "01  交互层",
    entry: ["浏览器 / Electron", "共用 React 界面"],
    workbench: ["React + TypeScript 工作台", "对话 · 会话导航 · Dock 面板 · 设置"],
    pluginUI: ["插件视图", "内置面板 / 扩展 UI"],
    transport: "通信边界     HTTP 动作请求 / NDJSON 实时事件 · Bearer + Origin 校验",
    host: "02  本地 Node 宿主",
    orchestration: ["应用编排与生命周期", "会话 / 工作区 / 模型认证 / 附件"],
    registry: ["插件注册与运行管理", "Files · Git · Terminal / Hosted 扩展"],
    hostNote: "Pi 薄适配入口 · 前台 / 后台会话 · 插件开关与资源清理",
    runtime: "03  执行与外部能力",
    pi: ["Pi SDK · AgentSession"],
    models: ["模型服务 · Provider APIs"],
    tools: ["文件系统 · Git · PTY / 进程"],
    contracts: "跨端契约",
    contractBody: ["Typed DTO", "事件校验", "插件 / Workbench API", "", "浏览器不依赖", "Node / Pi 运行时对象"],
    extensions: "可选扩展",
    extensionBody: ["Hosted 插件运行时", "独立 Node 子进程", "", "Excalidraw 官方插件", "可选安装，非内置"],
    support: "横切支撑",
    supportBody: ["Sentry · 诊断", "CLI / 桌面启动与更新"],
    footer: "架构边界：本地模块化宿主，不是微服务集群；同层模块并列展示，不表示串行调用。",
    source: "依据当前源码：src/host · src/plugins/builtin · src/contracts · web · desktop",
  },
};

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function render(locale, c) {
  const elements = [];
  function rect(x, y, width, height, fill, stroke) {
    elements.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
  }
  function text(x, y, value, size = 18, color = "#334155", weight = 400, anchor = "start") {
    elements.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`);
  }
  function lines(x, y, values, size = 17, color = "#475569", step = 25) {
    values.forEach((value, index) => { if (value) text(x, y + index * step, value, size, color); });
  }
  function card(id, x, y, width, height, values, fill = "#ffffff", stroke = "#cbd5e1", size = 18) {
    elements.push(`<g id="${id}" data-card="true">`);
    rect(x, y, width, height, fill, stroke);
    const firstBaseline = y + height / 2 - (values.length - 1) * 12 + 6;
    values.forEach((value, index) => text(x + width / 2, firstBaseline + index * 24, value, size, "#334155", index === 0 ? 600 : 400, "middle"));
    elements.push("</g>");
  }
  function side(id, y, height, title, body, fill, stroke, color, size = 17) {
    elements.push(`<g id="${id}" data-card="true">`);
    rect(1092, y, 248, height, fill, stroke);
    text(1116, y + 42, title, 20, color, 600);
    lines(1116, y + 94, body, size, color);
    if (id === "contracts") text(1116, 476, "src/contracts", 15, "#64748b");
    elements.push("</g>");
  }

  text(60, 54, "SYSTEM ARCHITECTURE / PI WEBAPP", 16, "#64748b", 600);
  text(60, 110, c.title, 36, "#0f172a", 700);
  text(60, 150, c.subtitle, 18, "#64748b");

  rect(60, 190, 1000, 180, "#f8fafc", "#cbd5e1");
  text(84, 234, c.ui, 20, "#334155", 600);
  text(1036, 234, "web/src/ui · src/host/client", 15, "#64748b", 400, "end");
  card("entry", 84, 262, 190, 76, c.entry, "#ffffff", "#cbd5e1", 17);
  card("workbench", 298, 262, 464, 76, c.workbench, "#eaf2f9", "#93b5d4");
  card("plugin-ui", 786, 262, 250, 76, c.pluginUI, "#ffffff", "#cbd5e1", 16);

  card("transport", 60, 418, 1000, 74, [c.transport], "#eef4f8", "#a8bdce", 19);

  rect(60, 540, 1000, 228, "#f5f3f9", "#b8b0d1");
  text(84, 584, c.host, 20, "#504565", 600);
  text(1036, 584, "src/host/server", 15, "#776e89", 400, "end");
  card("orchestration", 84, 610, 440, 82, c.orchestration, "#ffffff", "#b8b0d1", 17);
  card("plugin-registry", 548, 610, 488, 82, c.registry, "#ebe7f4", "#b8b0d1", 17);
  text(84, 738, c.hostNote, 16, "#776e89");

  rect(60, 816, 1000, 156, "#f1f7f4", "#abc4b7");
  text(84, 860, c.runtime, 20, "#365c4a", 600);
  card("pi-runtime", 84, 884, 292, 62, c.pi, "#ffffff", "#abc4b7");
  card("model-providers", 400, 884, 288, 62, c.models, "#ffffff", "#abc4b7");
  card("local-tools", 712, 884, 324, 62, c.tools, "#ffffff", "#abc4b7", 17);

  side("contracts", 190, 302, c.contracts, c.contractBody, "#f8fafc", "#cbd5e1", "#475569", 16);
  side("extensions", 540, 228, c.extensions, c.extensionBody, "#faf7f1", "#c5bba9", "#756044", 16);
  side("support", 816, 156, c.support, c.supportBody, "#f8fafc", "#cbd5e1", "#475569", 14);

  for (const [start, end] of [[373, 411], [495, 533], [771, 809]]) {
    elements.push(`<path d="M560 ${start} V${end}" fill="none" stroke="#7b8fa1" stroke-width="2" marker-end="url(#arrow)"/>`);
  }
  elements.push('<path d="M60 1014 H1340" fill="none" stroke="#e2e8f0"/>');
  text(60, 1058, c.footer, 16, "#64748b");
  text(60, 1090, c.source, 14, "#64748b");

  return `<svg xmlns="http://www.w3.org/2000/svg" xml:lang="${locale === "zh" ? "zh-CN" : "en"}" width="1400" height="1120" viewBox="0 0 1400 1120" role="img" aria-labelledby="title desc">
  <title id="title">${escape(c.title)}</title>
  <desc id="desc">${escape(c.description)}</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M1 1 9 5 1 9Z" fill="#7b8fa1"/></marker>
  </defs>
  <rect width="1400" height="1120" rx="16" fill="#ffffff"/>
  <g font-family="Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif" stroke-linejoin="round" stroke-linecap="round">
    ${elements.join("\n    ")}
  </g>
</svg>
`;
}

for (const [locale, content] of Object.entries(copy)) {
  const target = new URL(`../assets/readme/architecture-${locale}.svg`, import.meta.url);
  await writeFile(target, render(locale, content));
  console.log(`Updated ${target.pathname}`);
}
