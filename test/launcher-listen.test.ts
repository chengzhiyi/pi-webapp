import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL("../bin/pi-webapp.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server) {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}

async function launcherFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-launcher-listen-"));
  const agentDir = join(root, "agent");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEBAPP_PI_CLI: cli, PI_WEBAPP_AUTO_OPEN: "0", PI_WEBAPP_RUNTIME: "npm" };
  for (const key of ["PI_WEBAPP_RESTART_PORT", "PI_WEBAPP_RESTART_TOKEN", "PI_WEBAPP_PLUGIN_DEV_ROOTS", "PI_WEBAPP_LAUNCHER_NONCE"]) delete env[key];
  const run = (...args: string[]) => exec(process.execPath, [launcher, ...args], { cwd: root, env, timeout: 12_000 });
  const state = async () => JSON.parse(await readFile(join(agentDir, "pi-web/launcher.json"), "utf8"));
  return { root, run, state, cleanup: async () => {
    try { await run("stop", "--force"); } finally { await rm(root, { recursive: true, force: true }); }
  } };
}

test("CLI rejects invalid listen parameters before starting Pi", async () => {
  const fixture = await launcherFixture();
  try {
    for (const args of [["--port"], ["--port=0"], ["--port", "65536"], ["--port=1.5"], ["--host"], ["--host", "example.com"], ["--port=3000", "--port=3001"]]) {
      await assert.rejects(fixture.run("start", ...args), { code: 1, stderr: /pi-webapp: --(?:port|host)/ });
    }
    await assert.rejects(fixture.state(), { code: "ENOENT" });
  } finally { await fixture.cleanup(); }
});

test("CLI reports a busy fixed port without starting on a different port", { timeout: 20_000 }, async () => {
  const fixture = await launcherFixture();
  const blocker = createServer();
  try {
    const port = await listen(blocker);
    await assert.rejects(fixture.run("--port", String(port)), { code: 1, stderr: new RegExp(`${port}.*EADDRINUSE`) });
  } finally { await close(blocker); await fixture.cleanup(); }
});

test("CLI defaults to an automatic loopback port and allows changing to a fixed loopback port", { timeout: 30_000 }, async () => {
  const fixture = await launcherFixture();
  try {
    await fixture.run("start");
    const initial = await fixture.state();
    const url = new URL(initial.url);
    assert.equal(initial.listenHost, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
    await fixture.run("stop");
    await fixture.run(`--port=${url.port}`);
    const fixed = await fixture.state();
    assert.equal(fixed.listenHost, "127.0.0.1");
    assert.equal(new URL(fixed.url).origin, url.origin);
    assert.match((await fixture.run("--port", url.port)).stdout, /已在后台运行/);
  } finally { await fixture.cleanup(); }
});

test("real CLI serves the UI and accepts a message through a different published port", { timeout: 30_000 }, async () => {
  const fixture = await launcherFixture();
  const reservation = createServer();
  let proxy: Server | undefined;
  try {
    const port = await listen(reservation);
    await close(reservation);
    const marker = join(fixture.root, "message-received");
    const extension = join(fixture.root, "acceptance.mjs");
    await writeFile(extension, `import { writeFile } from "node:fs/promises";
export default (pi) => pi.registerCommand("acceptance", { handler: (text) => writeFile(${JSON.stringify(marker)}, text) });
`);
    await fixture.run("start", "--host=0.0.0.0", "--port", String(port), "-e", extension);
    const state = await fixture.state(), internal = new URL(state.url);
    assert.equal(state.listenHost, "0.0.0.0");
    assert.equal(internal.origin, `http://127.0.0.1:${port}`);
    await assert.rejects(fixture.run("--host=127.0.0.1"), { code: 1, stderr: /不同的监听配置/ });

    // A TCP forwarder preserves Host and Origin exactly like a Docker port mapping.
    proxy = createServer(client => {
      const upstream = connect(port, "127.0.0.1");
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    const publishedPort = await listen(proxy);
    const origin = `http://127.0.0.1:${publishedPort}`;
    const headers = { Authorization: `Bearer ${internal.hash.slice(1)}`, "Content-Type": "application/json", Connection: "close" };
    const page = await fetch(origin, { headers: { Connection: "close" } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html\b/);
    const session = await fetch(`${origin}/api/session`, { headers });
    assert.equal(session.status, 200);
    const { sessionId } = await session.json();
    const send = (selected: Record<string, string>) => fetch(`${origin}/api/message`, {
      method: "POST", headers: { ...headers, Origin: origin, ...selected }, body: JSON.stringify({ sessionId, text: "/acceptance mapped message" }),
    });
    const badOrigin = await send({ Origin: internal.origin, "X-Forwarded-Host": internal.host });
    assert.equal(badOrigin.status, 403);
    await badOrigin.text();
    const badToken = await send({ Authorization: "Bearer invalid" });
    assert.equal(badToken.status, 401);
    await badToken.text();
    const badHost = request(`${origin}/`, { headers: { Host: `example.test:${publishedPort}`, Connection: "close" } });
    badHost.end();
    const [badHostResponse] = await once(badHost, "response");
    assert.equal(badHostResponse.statusCode, 403);
    badHostResponse.resume();
    const accepted = await send({});
    assert.equal(accepted.status, 202, await accepted.text());
    // Acknowledgment can precede the asynchronous handler's file write.
    let received = "";
    for (let attempt = 0; attempt < 100 && !received; attempt++) {
      received = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
      if (!received) await delay(20);
    }
    assert.equal(received, "mapped message");
  } finally {
    if (proxy) await close(proxy);
    await close(reservation);
    await fixture.cleanup();
  }
});
