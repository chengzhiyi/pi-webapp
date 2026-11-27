// Local, headed Electron acceptance. Prepare with `npm run desktop:prepare`,
// then run `node scripts/smoke-desktop-web-preview.mjs` (no browser install).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "@playwright/test";
import { redactDiagnostic, seedSmokeLocale } from "./desktop-smoke-diagnostics.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const executablePath = process.env.PI_WEB_DESKTOP_EXECUTABLE;
const timeout = 10000;
const previewName = /^(Web Preview|网页预览)$/;
const closeSettingsName = /^(Close Pi settings|关闭 Pi 设置)$/;
const optionalPublicSmoke = process.env.PI_WEB_PREVIEW_SMOKE_PUBLIC === "1";
const optionalGoogleSmoke = process.env.PI_WEB_PREVIEW_SMOKE_GOOGLE === "1";
const phase = name => console.log(`Web Preview smoke: ${name}`);
const poll = (fn, message) => expect.poll(fn, { timeout, message });

const fixtureHtml = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Workspace Preview Fixture</title><main>
<h1 id="route"></h1><a id="details" href="/details">Open details</a>
<button id="counter" type="button">Clicks: 0</button><p id="fixture-data"></p>
</main><script>
  document.querySelector('#route').textContent = location.pathname === '/details' ? 'Fixture detail' : 'Fixture home';
  let clicks = 0;
  document.querySelector('#counter').addEventListener('click', event => {
    event.currentTarget.textContent = 'Clicks: ' + (++clicks);
  });
  const render = () => fetch('/api/data').then(response => response.json()).then(data => {
    document.querySelector('#fixture-data').textContent = data.message;
  });
  void render();
  const updates = new WebSocket('ws://' + location.host + '/hot');
  updates.onopen = () => { document.body.dataset.hot = 'connected'; };
  updates.onmessage = render;
</script></html>`;

const hotClients = new Set();
let blockedRedirect;
function fixtureServer(workspace) {
  const server = createServer(async (request, response) => {
    if (request.url === "/backend-redirect" && blockedRedirect) {
      response.writeHead(302, { Location: blockedRedirect }).end();
      return;
    }
    if (request.url === "/dev-redirect") {
      response.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/details` }).end();
      return;
    }
    const asset = { "/": "index.html", "/details": "index.html", "/api/data": "data.json" }[request.url];
    if (!asset) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(workspace, asset));
      response.writeHead(200, {
        "Content-Type": asset === "index.html" ? "text/html; charset=utf-8" : "application/json",
        "Cache-Control": "no-store",
        // A frame-based implementation must not accidentally pass this test.
        "X-Frame-Options": "DENY",
      }).end(body);
    } catch { response.writeHead(500).end(); }
  });
  // Minimal local WebSocket fixture: send just one short, unmasked text frame.
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (request.url !== "/hot" || typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    hotClients.add(socket);
    socket.on("close", () => hotClients.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", chunk => { if (chunk[0] === 0x88) socket.end(Buffer.from([0x88, 0])); });
  });
  return server;
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server.address().port;
}

async function stopServer(server) {
  if (!server.listening) return;
  for (const socket of hotClients) socket.destroy();
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function bounded(promise, ms = timeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Electron operation timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-web-preview-"));
// DesktopBackend starts the workspace in homedir(). Keep the fixture in that
// real workspace, and keep the Electron and Pi state in other temporary paths.
const workspace = join(temporary, "workspace");
const profile = join(temporary, "electron");
const agentDir = join(temporary, "agent");
const launcherState = join(agentDir, "pi-web", "launcher.json");
const writeData = message => writeFile(join(workspace, "data.json"), JSON.stringify({ message }));
const server = fixtureServer(workspace);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PI_/i.test(key)));
Object.assign(env, {
  HOME: workspace, USERPROFILE: workspace,
  XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
  XDG_STATE_HOME: join(temporary, "state"), XDG_CACHE_HOME: join(temporary, "cache"),
  APPDATA: join(temporary, "appdata"), LOCALAPPDATA: join(temporary, "localappdata"),
  PI_CODING_AGENT_DIR: agentDir, PI_WEBAPP_AUTO_OPEN: "0", PI_WEB_SENTRY_ENABLED: "false",
  PI_WEBAPP_DESKTOP_UPDATE_CHECK: "manual",
});
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;
let electron;
let page;
let state;
let shellId;

// Find a WebContentsView attached to the shell's native window, not a shell
// iframe, detached target, DevTools session, or second BrowserWindow.
function nativeViews() {
  return bounded(electron.evaluate(({ BrowserWindow }, shellId) => {
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents.id === shellId);
    const views = [];
    const walk = parent => {
      for (const view of parent.children) {
        const contents = view.webContents;
        if (contents && contents.id !== shellId && !contents.isDestroyed()) {
          views.push({ id: contents.id, bounds: view.getBounds(), visible: view.getVisible() });
        }
        walk(view);
      }
    };
    if (owner) walk(owner.contentView);
    return views;
  }, shellId));
}

function guestDocument(id, selector) {
  return bounded(electron.evaluate(async ({ webContents }, { id, selector }) => {
    const guest = webContents.fromId(id);
    if (!guest || guest.isDestroyed() || guest.isLoadingMainFrame()) return null;
    // Read-only DOM probe, executed on the guest, never the workbench page.
    const text = selector ? `document.querySelector(${JSON.stringify(selector)})?.innerText ?? null` : "document.title";
    const script = `({ url: location.href, text: ${text}, bridge: typeof globalThis.piWebPreview, node: typeof globalThis.require })`;
    try { return await guest.executeJavaScript(script); }
    catch { return null; } // The previous document can disappear during navigation.
  }, { id, selector }));
}

async function guestClick(id, selector) {
  await poll(async () => (await nativeViews()).some(view => view.id === id && visibleView(view)),
    `native guest is attached before clicking ${selector}`).toBe(true);
  // BrowserWindow's Playwright page only targets the shell. Send native mouse
  // input to the guest at the fixture element's rendered coordinates instead.
  const delivered = await bounded(electron.evaluate(async ({ webContents }, { id, selector }) => {
    const guest = webContents.fromId(id);
    const point = await guest.executeJavaScript(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      const rect = target.getBoundingClientRect();
      const x = Math.floor(rect.left + rect.width / 2);
      const y = Math.floor(rect.top + rect.height / 2);
      return target.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    if (!point) return false;
    guest.focus();
    guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    return true;
  }, { id, selector }));
  assert.ok(delivered, `Guest target ${selector} must be hit-testable`);
}

const visibleView = view => view.visible && view.bounds.width > 0 && view.bounds.height > 0;

try {
  await mkdir(workspace);
  await writeFile(join(workspace, "index.html"), fixtureHtml);
  await writeData("Workspace fixture data v1");
  const port = await listen(server);
  const origin = `http://localhost:${port}`;

  phase("start real desktop with an isolated profile");
  electron = await _electron.launch({ executablePath,
    args: [...(executablePath ? [] : [join(root, "desktop")]), `--user-data-dir=${profile}`], env, timeout: 60000 });
  // Stub OS side effects to avoid changing the real clipboard or opening the user's browser.
  assert.equal(await realpath(await electron.evaluate(({ app, clipboard, dialog, shell }) => {
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    clipboard.writeText = url => { globalThis.previewCopiedForSmoke = url; };
    shell.openExternal = async url => { globalThis.previewOpenedForSmoke = url; };
    return app.getPath("userData");
  })), await realpath(profile));
  await electron.context().addInitScript(seedSmokeLocale);
  page = await electron.firstWindow({ timeout: 70000 });
  page.setDefaultTimeout(timeout);
  const closeSettings = page.getByRole("button", { name: closeSettingsName });
  await expect(closeSettings).toBeVisible({ timeout: 45000 });
  await closeSettings.click();
  state = JSON.parse(await readFile(launcherState, "utf8"));
  assert.equal(state.runtimeKind, "desktop");
  assert.equal(await realpath(state.cwd), await realpath(workspace));
  const backendOrigin = new URL(state.url).origin; // Never enter the launch token into preview.
  blockedRedirect = `http://localhost:${new URL(backendOrigin).port}/`;
  const window = await electron.browserWindow(page);
  shellId = await window.evaluate(window => window.webContents.id);
  await window.dispose();
  assert.equal(new URL(page.url()).origin, backendOrigin);
  assert.deepEqual(await page.evaluate(() => {
    const bridge = globalThis.piWebPreview;
    return ["open", "command", "layout", "close", "onState"].map(method => typeof bridge?.[method]);
  }), Array(5).fill("function"), "Native Web Preview preload is not installed on the shell");

  phase("open the built-in Web Preview from the workbench launcher");
  const rightbar = page.locator("[data-sidebar-right-session]");
  const expand = page.getByRole("button", { name: /^(Open right sidebar|打开右侧边栏)$/ });
  if (await expand.isVisible()) await expand.click();
  const launcher = rightbar.getByRole("group", { name: /^(Workspace tools|工作区工具)$/ })
    .getByRole("button", { name: previewName });
  await launcher.click();
  const panel = rightbar.getByRole("region", { name: previewName });
  const address = panel.getByRole("textbox", { name: /^(Search or enter a URL|搜索或输入网址)$/ });
  const go = panel.getByRole("button", { name: /^(Go|打开)$/ });
  const back = panel.getByRole("button", { name: /^(Back|后退)$/ });
  const forward = panel.getByRole("button", { name: /^(Forward|前进)$/ });
  const refresh = panel.getByRole("button", { name: /^(Reload|重新加载)$/ });
  const retry = panel.getByRole("button", { name: /^(Retry|重试)$/ });
  const alert = panel.getByRole("alert");
  const ready = panel.getByRole("status").filter({ hasText: /Preview ready|预览已就绪/ });
  await expect(panel.getByText(/Search terms are sent to Google|仅在提交搜索时/)).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^(Collapse preview|收起预览)$/ })).toHaveCount(0);
  const [backBox, addressBox] = await Promise.all([back.boundingBox(), address.boundingBox()]);
  assert.ok(backBox && addressBox && Math.abs(backBox.y + backBox.height / 2 - addressBox.y - addressBox.height / 2) < 2,
    "the address field shares the navigation row at the normal desktop width");
  async function navigate(url) {
    await address.fill(url);
    await go.click();
  }
  await address.fill(`localhost:${port}`);
  await address.press("Enter");
  await expect(address).toHaveValue(`${origin}/`);
  await poll(async () => (await nativeViews()).filter(visibleView).length, "one visible native guest").toBe(1);
  const guestId = (await nativeViews()).find(visibleView).id;
  const guestShows = (path, selector, text) => poll(() => guestDocument(guestId, selector), `guest shows ${path}: ${text}`)
    .toEqual({ url: `${origin}${path}`, text, bridge: "undefined", node: "undefined" });
  await guestShows("/", "h1", "Fixture home");
  await guestShows("/", "#fixture-data", "Workspace fixture data v1");
  assert.equal(await page.locator("#fixture-data").count(), 0, "fixture DOM must not be in the shell");
  assert.equal(new URL(page.url()).origin, backendOrigin);

  phase("click a guest link and exercise native back/forward and refresh");
  await guestClick(guestId, "#details");
  await guestShows("/details", "h1", "Fixture detail");
  await expect(address).toHaveValue(`${origin}/details`);
  await back.click();
  await guestShows("/", "h1", "Fixture home");
  await expect(address).toHaveValue(`${origin}/`);
  await forward.click();
  await guestShows("/details", "h1", "Fixture detail");
  await expect(address).toHaveValue(`${origin}/details`);
  await guestShows("/details", "#fixture-data", "Workspace fixture data v1");
  await panel.getByRole("button", { name: /^(Copy URL|复制地址)$/ }).click();
  await expect(panel.getByRole("status").filter({ hasText: /URL copied|地址已复制/ })).toBeAttached();
  await panel.getByRole("button", { name: /^(Open in system browser|在系统浏览器中打开)$/ }).click();
  await poll(() => electron.evaluate(() => [globalThis.previewCopiedForSmoke, globalThis.previewOpenedForSmoke]),
    "the host copied and opened the current local address").toEqual(Array(2).fill(`${origin}/details`));
  phase("receive a local WebSocket update without reloading");
  await poll(() => electron.evaluate(async ({ webContents }, guestId) => webContents.fromId(guestId)
    ?.executeJavaScript("document.body.dataset.hot"), guestId), "the guest connected to its hot-update server").toBe("connected");
  await writeData("Workspace fixture hot update");
  for (const socket of hotClients) socket.write(Buffer.from([0x81, 1, 0x31]));
  await guestShows("/details", "#fixture-data", "Workspace fixture hot update");
  await writeData("Workspace fixture data v2");
  await refresh.click();
  await guestShows("/details", "#fixture-data", "Workspace fixture data v2");

  phase("switch workbench tabs without reloading the native document");
  await guestClick(guestId, "#counter");
  await guestShows("/details", "#counter", "Clicks: 1");
  const previewTab = rightbar.getByRole("tab", { name: /Web Preview|网页预览/ });
  const newTab = rightbar.getByRole("button", { name: /^(New tab|新标签页)$/ });
  await newTab.click();
  await expect(previewTab).toHaveAttribute("aria-selected", "false");
  await rightbar.getByRole("button", { name: /^(Open terminal|打开终端)$/ }).click();
  const terminalTab = rightbar.getByRole("tab", { name: /Terminal|终端/ });
  await expect(terminalTab).toHaveAttribute("aria-selected", "true");
  const previewVisible = async () => (await nativeViews()).some(view => view.id === guestId && visibleView(view));
  await poll(previewVisible, "inactive tab hides the native view").toBe(false);
  await previewTab.click();
  await expect(previewTab).toHaveAttribute("aria-selected", "true");
  await poll(previewVisible, "reactivation shows the same native view").toBe(true);
  await guestShows("/details", "#counter", "Clicks: 1");

  phase("collapse and reopen the workbench without losing page state");
  await rightbar.getByRole("button", { name: /^(Collapse right sidebar|收起右侧边栏)$/ }).click();
  await expect(expand).toBeVisible();
  await poll(previewVisible, "collapsing the workbench detaches the native view").toBe(false);
  await expand.click();
  await poll(previewVisible, "reopening the workbench reattaches the same native view").toBe(true);
  await guestShows("/details", "#counter", "Clicks: 1");

  phase("hide the native view behind Pi settings and resize it with the window");
  await page.getByRole("button", { name: /^(Pi Settings|Pi 设置)$/ }).click();
  await expect(closeSettings).toBeVisible();
  await poll(previewVisible, "settings dialog hides the preview").toBe(false);
  await closeSettings.click();
  await poll(previewVisible, "closing settings restores the preview").toBe(true);
  await guestShows("/details", "#counter", "Clicks: 1");
  const savedBounds = (await nativeViews()).find(view => view.id === guestId).bounds;
  await electron.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.id === id);
    const [width, height] = win.getSize();
    win.setSize(width, height - 150);
  }, shellId);
  await poll(async () => (await nativeViews()).find(view => view.id === guestId)?.bounds.height ?? Infinity,
    "guest follows the resized workbench viewport").toBeLessThan(savedBounds.height);
  await guestShows("/details", "#counter", "Clicks: 1");

  phase("missing local service shows failure and Retry recovers");
  await stopServer(server);
  await navigate(`${origin}/`);
  await expect(retry).toBeVisible({ timeout });
  await expect(alert).toHaveText(/The page failed to load|页面加载失败/, { timeout });
  await listen(server, port);
  await retry.click();
  await expect(ready).toBeAttached({ timeout });
  await guestShows("/", "#fixture-data", "Workspace fixture data v2");

  phase("follow ordinary HTTP redirects, but block navigation and redirects to Pi's backend aliases");
  await navigate(`${origin}/dev-redirect`);
  await expect(address).toHaveValue(`http://127.0.0.1:${port}/details`);
  await poll(() => guestDocument(guestId, "h1"), "redirected HTTP page is rendered")
    .toMatchObject({ url: `http://127.0.0.1:${port}/details`, text: "Fixture detail" });
  await navigate(`${origin}/backend-redirect`);
  const blocked = /This address is blocked in Web Preview|此地址无法在网页预览中打开/;
  await expect(alert).toHaveText(blocked, { timeout });

  for (const [target, message] of [["file:///tmp/test.html", /Enter an HTTP or HTTPS address|请输入 HTTP 或 HTTPS 地址/],
    [`${backendOrigin}/`, blocked], [blockedRedirect, blocked]]) {
    await navigate(target);
    await expect(alert).toHaveText(message, { timeout });
    const guestURL = await bounded(electron.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), guestId));
    assert.notEqual(guestURL, target);
    assert.equal(new URL(page.url()).origin, backendOrigin);
    await navigate(`${origin}/`);
    await expect(ready).toBeAttached({ timeout });
    await guestShows("/", "#fixture-data", "Workspace fixture data v2");
  }

  phase("submit keywords in the omnibox and navigate a result in the same guest");
  // Keep the default smoke independent of the network and Google consent/CAPTCHA.
  // Fulfil only the known destination in the real guest; the UI, request policy,
  // address encoding, navigation history and native rendering remain unstubbed.
  const query = "Electron 中文 + preview";
  const search = new URL("https://www.google.com/search");
  search.searchParams.set("q", query);
  await electron.evaluate(async ({ webContents }, { guestId, search, origin }) => {
    const debugger_ = webContents.fromId(guestId).debugger;
    debugger_.attach();
    debugger_.on("message", (_event, method, { requestId, request } = {}) => {
      if (method !== "Fetch.requestPaused") return;
      const html = `<!doctype html><title>Search fixture</title><h1>Google search fixture</h1><a id="result" href="${origin}/details">Open result</a>`;
      const operation = request.url === search
        ? debugger_.sendCommand("Fetch.fulfillRequest", { requestId, responseCode: 200, body: Buffer.from(html).toString("base64"),
          responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }] })
        : debugger_.sendCommand("Fetch.continueRequest", { requestId });
      void operation.catch(() => {});
    });
    await debugger_.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "https://www.google.com/search*", resourceType: "Document" }] });
  }, { guestId, search: search.href, origin });
  await address.fill(query);
  await expect(address).toHaveValue(query);
  await guestShows("/", "h1", "Fixture home");
  await address.press("Enter");
  await expect(address).toHaveValue(search.href);
  await poll(() => guestDocument(guestId, "h1"), "encoded Google destination renders in the guest")
    .toEqual({ url: search.href, text: "Google search fixture", bridge: "undefined", node: "undefined" });
  await guestClick(guestId, "#result");
  await guestShows("/details", "h1", "Fixture detail");
  await back.click();
  await expect(address).toHaveValue(search.href);
  await electron.evaluate(async ({ webContents }, id) => {
    const debugger_ = webContents.fromId(id).debugger;
    await debugger_.sendCommand("Fetch.disable");
    debugger_.detach();
  }, guestId);

  if (optionalGoogleSmoke) {
    phase("check live Google connectivity from the embedded guest");
    const liveQuery = "pi webapp electron preview";
    await navigate(liveQuery);
    await expect.poll(async () => {
      const result = await guestDocument(guestId);
      if (!result?.text || result.text === "Search fixture") return false;
      const url = new URL(result.url);
      return (url.hostname === "google.com" || url.hostname.endsWith(".google.com")) &&
        (url.searchParams.get("q") === liveQuery || url.hostname === "consent.google.com" || url.pathname.startsWith("/sorry/"));
    }, { timeout: 25000, message: "expected the new live Google search, consent, or challenge page" }).toBe(true);
  }

  if (optionalPublicSmoke) {
    phase("open a real public HTTPS site from a bare domain");
    await navigate("example.com");
    await poll(() => guestDocument(guestId), "public example.com loads inside the isolated guest")
      .toEqual({ url: "https://example.com/", text: "Example Domain", bridge: "undefined", node: "undefined" });
  }

  phase("closing the tab destroys its native guest");
  await previewTab.getByRole("button", { name: /^(Close|关闭)$/ }).click();
  await expect(previewTab).toHaveCount(0);
  await poll(() => bounded(electron.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id);
    return !guest || guest.isDestroyed();
  }, guestId)), "the closed guest WebContents is destroyed, not just detached").toBe(true);
  assert.equal(new URL(page.url()).origin, backendOrigin);
  console.log("Web Preview smoke passed.");
} catch (error) {
  state ??= await readFile(launcherState, "utf8").then(JSON.parse).catch(() => undefined);
  const token = state?.url ? new URL(state.url).hash.slice(1) : undefined;
  console.error(redactDiagnostic(error.stack ?? String(error), env, [token, state?.nonce]));
  if (page && shellId) {
    const diagnostics = await bounded(Promise.all([
      page.evaluate(() => {
        const anchor = document.querySelector("[data-web-preview-state]");
        const bounds = anchor?.getBoundingClientRect();
        const center = bounds && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { visibility: document.visibilityState, previewStatus: anchor?.getAttribute("data-web-preview-state"),
          panelText: anchor?.closest("section")?.textContent, bounds: bounds?.toJSON(), center: center?.className,
          overlays: [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open], [role="menu"]')]
            .filter(node => node.getClientRects().length).map(node => node.getAttribute("aria-label")) };
      }),
      electron.evaluate(({ webContents }) => webContents.getAllWebContents()
        .map(contents => ({ id: contents.id, type: contents.getType(), url: contents.getURL() }))),
      nativeViews(),
    ])).catch(() => null);
    if (diagnostics) console.error(redactDiagnostic(JSON.stringify(diagnostics), env, [token, state?.nonce]));
  }
  process.exitCode = 1;
} finally {
  if (electron) {
    const child = electron.process();
    await bounded(electron.close()).catch(() => child.kill("SIGKILL"));
  }
  await stopServer(server);
  // As in the existing smoke, clean up only this run's backend on failure.
  try {
    const owned = JSON.parse(await readFile(launcherState, "utf8"));
    await writeFile(join(agentDir, "pi-web", "launcher.stop"), owned.nonce);
    for (let attempt = 0; attempt < 150; attempt++) {
      try { process.kill(owned.pid, 0); } catch { break; }
      await delay(100);
    }
  } catch { /* The isolated backend already stopped. */ }
  await rm(temporary, { recursive: true, force: true });
}
