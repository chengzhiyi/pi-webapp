import assert from "node:assert/strict";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The standalone launcher module has no declaration file.
import { showDoctor, showStatus } from "../bin/launcher-diagnostics.mjs";

const token = "abcdefghijklmnopqrstuvwxyz012345";
const cliVersion = "0.1.52";
const deadPid = 0x7fffffff;

function stdout(t: TestContext) {
  const log = t.mock.method(console, "log", () => {});
  return () => log.mock.calls.map(call => call.arguments.join(" ")).join("\n");
}

async function serve(t: TestContext, handler?: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    if (!server.listening) return;
    return new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

async function tempDir(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-launcher-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("status reports absent and dead launchers as stopped, and recognizes startup", async t => {
  const output = stdout(t);
  for (const state of [null, { pid: deadPid, starting: true }, { starting: true }, { pid: process.pid, starting: true, version: "0.1.51" }]) {
    await showStatus({ state, cliVersion });
  }
  const [absent, stale, sentinel, starting] = output().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(absent, { status: "stopped", pid: null, piPid: null, listenHost: null, port: null, runningVersion: null, cliVersion, url: null });
  assert.deepEqual(stale, absent);
  assert.deepEqual(sentinel, { ...absent, status: "starting" });
  assert.deepEqual(starting, { ...sentinel, pid: process.pid, runningVersion: "0.1.51" });
});

test("status authenticates against the version route and prints a token-free origin", async t => {
  const output = stdout(t);
  const { port, origin } = await serve(t, (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/api/update/version");
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.end(JSON.stringify({ current: "0.1.50", desktopProtocolVersion: 1, ignored: token }));
  });
  await showStatus({ cliVersion, state: {
    pid: process.pid, piPid: process.pid, listenHost: "0.0.0.0", version: "0.1.49",
    url: `${origin}/path-secret?secret=query-secret#${token}`,
  } });
  assert.deepEqual(JSON.parse(output()), { status: "healthy", pid: process.pid, piPid: process.pid,
    listenHost: "0.0.0.0", port, runningVersion: "0.1.50", cliVersion, url: `${origin}/` });
  assert.doesNotMatch(output(), new RegExp(`${token}|path-secret|query-secret`));
});

test("status rejects unsafe addresses and does not follow even same-origin redirects", async t => {
  const output = stdout(t);
  const paths: (string | undefined)[] = [];
  const { port, origin } = await serve(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(302, { Location: `${origin}/redirect` }).end();
  });
  const urls = [
    `${origin}/#${token}`, `${origin}/`, `http://localhost:${port}/#${token}`,
    `http://user:password@127.0.0.1:${port}/#${token}`, `https://127.0.0.1:${port}/#${token}`,
  ];
  for (const url of urls) await showStatus({ cliVersion, state: { pid: process.pid, url } });
  assert.deepEqual(paths, ["/api/update/version"]);
  const results = output().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(results.map(result => result.status), urls.map(() => "unhealthy"));
  assert.deepEqual(results.map(result => result.url), [`${origin}/`, `${origin}/`, null, null, null]);
  assert.doesNotMatch(output(), new RegExp(`${token}|password`));
});

test("status handles authentication failures, malformed or oversized replies, and a stalled body", { timeout: 5000 }, async t => {
  const output = stdout(t);
  const { origin } = await serve(t, (_req, res) => {
    switch (response++) {
      case 0: res.writeHead(401).end(token); break;
      case 1: res.end("no JSON"); break;
      case 2: res.end(JSON.stringify({ current: "0.1.50", ignored: "x".repeat(20_000) })); break;
      default: res.write('{"current":'); break;
    }
  });
  let response = 0;
  for (let i = 0; i < 4; i++) {
    await showStatus({ cliVersion, state: { pid: process.pid, version: "0.1.49", url: `${origin}/#${token}` } });
  }
  const results = output().split("\n").map(line => JSON.parse(line));
  assert.equal(response, 4);
  assert.ok(results.every(result => result.status === "unhealthy" && result.runningVersion === "0.1.49"));
  assert.doesNotMatch(output(), new RegExp(token));
});

test("doctor checks a fresh directory without creating it and releases an available port", async t => {
  const output = stdout(t);
  const agentDir = join(await tempDir(t), "missing", "agent");
  const { server, port } = await serve(t);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.equal(await showDoctor({ args: [`--port=${port}`, "--host", "127.0.0.1"], agentDir,
    readState: () => null, probePi: async () => "0.87.1" }), true);
  assert.match(output(), /\[OK\] Node\.js/);
  assert.match(output(), /\[OK\] Pi: 0\.87\.1/);
  assert.match(output(), /\[OK\] Agent directory/);
  assert.match(output(), /\[OK\] Launcher state/);
  assert.match(output(), new RegExp(`\\[OK\\] Port: 127\\.0\\.0\\.1:${port}`));
  await assert.rejects(lstat(join(agentDir, "..")), { code: "ENOENT" });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
});

test("doctor reports stale state and a busy port without altering the state file", async t => {
  const output = stdout(t);
  const agentDir = await tempDir(t);
  const path = join(agentDir, "pi-web", "launcher.json");
  const { port, origin } = await serve(t);
  const raw = JSON.stringify({ pid: deadPid, url: `${origin}/#${token}` });
  await mkdir(join(agentDir, "pi-web"));
  await writeFile(path, raw);
  assert.equal(await showDoctor({ args: ["--port", String(port)], agentDir,
    readState: async () => JSON.parse(await readFile(path, "utf8")), probePi: () => "0.87.0" }), false);
  assert.match(output(), /\[FAIL\] Pi: 0\.87\.0/);
  assert.match(output(), new RegExp(`\\[FAIL\\] Launcher state: .*${deadPid}`));
  assert.match(output(), /\[FAIL\] Port: .*EADDRINUSE/);
  assert.doesNotMatch(output(), new RegExp(token));
  assert.equal(await readFile(path, "utf8"), raw);
});

test("doctor reports inaccessible state, a non-directory path, and missing or failed Pi probes", async t => {
  const output = stdout(t);
  const agentDir = await tempDir(t);
  await writeFile(join(agentDir, "pi-web"), "not a directory");
  const fail = () => { throw new Error(token); };
  for (const probePi of [() => null, fail]) {
    assert.equal(await showDoctor({ agentDir, readState: fail, probePi }), false);
  }
  assert.equal(output().match(/\[FAIL\] Pi:/g)?.length, 2);
  assert.match(output(), /\[FAIL\] Launcher directory/);
  assert.match(output(), /\[FAIL\] Launcher state/);
  assert.doesNotMatch(output(), new RegExp(`${token}|Port:`));
});

test("doctor rejects invalid or duplicate options before running checks", async t => {
  const output = stdout(t);
  const probePi = t.mock.fn(() => "0.87.1");
  for (const args of [["--port"], ["--port=0"], ["--port=65536"], ["--port=1.5"], ["--port=2000", "--port=2001"], ["--host"], ["--host=localhost"], ["unexpected"]]) {
    await assert.rejects(showDoctor({ args, probePi }), /--port|--host/);
  }
  assert.equal(probePi.mock.callCount(), 0);
  assert.equal(output(), "");
});
