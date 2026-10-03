import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { buildInfo, root } from "./build-config.mjs";
import { sha256, verifyPackageArtifacts, verifyResolvedEvent, releaseProbeLocation } from "./sentry-release.mjs";

const args = process.argv.slice(2);
const live = args.includes("--live");
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
let temporary;

async function run() {
  if (!live && !args.includes("--package-only")) throw new Error("Choose --package-only or --live explicitly");
  const token = process.env.SENTRY_VERIFY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = side => process.env[`SENTRY_${side.toUpperCase()}_PROJECT`] || process.env.SENTRY_PROJECT;
  if (live && (!token || !org || !project("node") || !project("browser"))) throw new Error("Live verification requires SENTRY_VERIFY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT (or per-side projects); no events were sent");
  const api = new URL(process.env.SENTRY_URL || "https://us.sentry.io/");
  if (live && (api.protocol !== "https:" || api.username || api.password || api.search || api.hash)) throw new Error("Invalid Sentry API destination");
  let tarball = option("--tarball");
  const manifest = option("--pack-manifest");
  if (manifest) {
    const packed = JSON.parse(await readFile(resolve(manifest), "utf8"));
    if (packed.length !== 1 || !/^[\w.-]+\.tgz$/.test(packed[0]?.filename)) throw new Error("Invalid npm pack manifest");
    tarball = join(dirname(resolve(manifest)), packed[0].filename);
  }
  if (!tarball) throw new Error("Provide --tarball FILE or --pack-manifest FILE");
  tarball = resolve(tarball);
  // Only npm's package/ tree is accepted; no archive paths may escape the temporary checkout.
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
  if (entries.some(file => !file.startsWith("package/") || file.includes("\\") || file.split("/").includes(".."))) throw new Error("Unsafe package archive paths");
  await mkdir(resolve(root, ".ci"), { recursive: true });
  temporary = await mkdtemp(resolve(root, ".ci/sentry-release-"));
  execFileSync("tar", ["-xzf", tarball, "-C", temporary], { stdio: "pipe" });
  const packageRoot = join(temporary, "package");
  const info = await buildInfo();
  const archiveRoot = resolve(option("--archive") || join(root, ".sentry-artifacts", info.buildId));
  const expected = await verifyPackageArtifacts(packageRoot, archiveRoot);
  const digest = sha256(await readFile(tarball));
  console.log(`Verified package ${expected.release}; sha256=${digest}`);
  if (!live) return;
  const locations = {
    node: releaseProbeLocation(JSON.parse(await readFile(join(archiveRoot, "node/extension.js.map"), "utf8")), "node"),
    browser: releaseProbeLocation(JSON.parse(await readFile(join(archiveRoot, "browser/assets/app.js.map"), "utf8")), "browser"),
  };
  const deadline = Date.now() + 120_000;
  process.env.PI_WEB_SENTRY_VERIFY_RELEASE = "true";
  process.env.PI_WEB_SENTRY_ENVIRONMENT = "sentry-verification";
  // This exact packaged module contains both the SDK capture path and its injected Debug ID.
  const { verifySentryNodeRelease } = await import(pathToFileURL(join(packageRoot, "dist/extension.js")).href);
  const node = await verifySentryNodeRelease();
  if (node.release !== expected.release || node.buildId !== expected.buildId) throw new Error("Packaged Node probe loaded a different build");
  const browserId = await browserProbe(packageRoot, expected, deadline);
  await Promise.all([waitForEvent(node.eventId, "node"), waitForEvent(browserId, "browser")]);
  await writeFile(join(dirname(tarball), "verified.json"), JSON.stringify({ filename: basename(tarball), sha256: digest, release: expected.release, buildId: expected.buildId, nodeEventId: node.eventId, browserEventId: browserId }, null, 2));
  console.log(`Sentry verified both application source maps for ${expected.release}`);

  async function waitForEvent(eventId, side) {
    let reason = "event not yet ingested";
    const endpoint = new URL(`/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project(side))}/events/${eventId}/json/`, api);
    while (Date.now() < deadline) {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) });
      if ([401, 403].includes(response.status)) throw new Error("Sentry verification token needs project read permission");
      if (response.ok) {
        try { verifyResolvedEvent(await response.json(), expected, side, locations[side]); console.log(`Verified ${side} event ${eventId}`); return; }
        catch (error) { reason = error.message; }
      } else if (response.status !== 404 && response.status !== 429 && response.status < 500) throw new Error(`Sentry event lookup failed (${response.status})`);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(3000, deadline - Date.now()))));
    }
    throw new Error(`${side}: Sentry verification timed out: ${reason}`);
  }
}

async function browserProbe(packageRoot, expected, deadline) {
  const dsn = process.env.PI_WEB_SENTRY_BROWSER_DSN ?? process.env.PI_WEB_SENTRY_DSN ?? "https://070c0b7c5ac18d940c294e63ecfa0793@o4506663318716416.ingest.us.sentry.io/4512191040716800";
  if (process.env.PI_WEB_SENTRY_ENABLED === "false" || !dsn) throw new Error("Browser verification transport is disabled");
  const destination = new URL(dsn);
  if (destination.protocol !== "https:" || !destination.username || destination.password || destination.search || destination.hash) throw new Error("Invalid browser verification DSN");
  const web = join(packageRoot, "web/dist");
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/api/telemetry/config") {
        if (request.headers.authorization !== "Bearer sentry-verification") { response.writeHead(401).end(); return; }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ enabled: true, dsn, environment: "sentry-verification", release: expected.release, buildId: expected.buildId })); return;
      }
      if (path.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end("{}"); return; }
      const file = resolve(web, `.${path === "/" ? "/index.html" : decodeURIComponent(path)}`);
      if (relative(web, file).startsWith("..")) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", file.endsWith(".js") ? "application/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ ...(process.env.PI_WEB_TEST_CHROME === "true" ? { channel: "chrome" } : {}) });
    const page = await browser.newPage();
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      return url.origin === origin || url.origin === destination.origin ? route.continue() : route.abort();
    });
    const probe = page.waitForRequest(request => {
      if (new URL(request.url()).origin !== destination.origin || request.method() !== "POST") return false;
      return request.postData()?.includes('"code":"sentry_release_probe"') ?? false;
    }, { timeout: Math.max(1, Math.min(20_000, deadline - Date.now())) });
    // Observe a request failure immediately so a failed navigation cannot leave an unhandled promise.
    const observed = probe.then(request => ({ request }), error => ({ error }));
    await page.goto(`${origin}/?sentry_release_probe=1#sentry-verification`, { timeout: 20_000 });
    const result = await observed;
    if (result.error) throw new Error("Packaged browser did not emit its verification event");
    const event = result.request.postData().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(item => item.contexts?.diagnostic?.code === "sentry_release_probe");
    if (!event || !/^[a-f0-9]{32}$/.test(event.event_id) || event.release !== expected.release || event.dist !== expected.buildId) throw new Error("Invalid packaged browser verification event");
    // Await the real intake response before closing the page and cancelling pending transports.
    const response = await result.request.response();
    if (!response?.ok()) throw new Error("Sentry rejected the browser verification event");
    return event.event_id;
  } finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

try { await run(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
