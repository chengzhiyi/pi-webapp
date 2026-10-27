import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exercise the exact packed Node entry and browser assets without contacting Sentry. */
export async function verifyDisabledTelemetry(packageRoot, expected, chromium) {
  const { verifySentryDisabledRelease } = await import(pathToFileURL(join(packageRoot, "dist/extension.js")).href);
  const result = await verifySentryDisabledRelease();
  assert.equal(result.release, expected.release);
  assert.equal(result.buildId, expected.buildId);
  assert.equal(result.browser.enabled, false);
  assert.equal(result.browser.dsn, undefined);
  const web = join(packageRoot, "web/dist");
  let configRead = false;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/api/telemetry/config") {
        if (request.headers.authorization !== "Bearer disabled-verification") { response.writeHead(401).end(); return; }
        configRead = true;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result.browser)); return;
      }
      if (path.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end("{}"); return; }
      const file = resolve(web, `.${path === "/" ? "/index.html" : decodeURIComponent(path)}`);
      if (relative(web, file).startsWith("..")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  let browser;
  const forbidden = [];
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
    const page = await browser.newPage();
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.includes("telemetry-client-")) {
        forbidden.push(url.origin === origin ? "telemetry SDK loaded" : "external request attempted");
        return route.abort();
      }
      return route.continue();
    });
    const configResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/telemetry/config");
    await page.goto(`${origin}/?sentry_release_probe=1#disabled-verification`);
    assert.equal((await (await configResponse).json()).enabled, false);
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error("Synthetic disabled telemetry probe") }));
      window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("Synthetic disabled rejection") }));
    });
    await page.waitForTimeout(500);
    assert.equal(configRead, true);
    assert.deepEqual(forbidden, [], "Disabled browser must not load the reporting SDK or attempt external traffic");
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
