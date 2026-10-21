import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { redactDiagnostic, saveSmokeDiagnostics, seedSmokeLocale } from "../../scripts/desktop-smoke-diagnostics.mjs";

test("locale injection skips opaque/error/external documents but never hides storage failures on the real loopback UI", () => {
  const code = `(${seedSmokeLocale.toString()})()`;
  for (const href of ["about:blank", "chrome-error://chromewebdata/", "file:///tmp/page", "https://example.test/"]) {
    const url = new URL(href);
    assert.doesNotThrow(() => runInNewContext(code, { location: url, get localStorage() { throw new Error("opaque origin storage denied"); } }));
  }
  let stored;
  runInNewContext(code, { location: new URL("http://127.0.0.1:4321/"), localStorage: { setItem(key, value) { stored = [key, value]; } } });
  assert.deepEqual(stored, ["pi-web-locale", "en"]);
  assert.throws(() => runInNewContext(code, { location: new URL("http://127.0.0.1:4321/"), localStorage: { setItem() { throw new Error("real UI storage broken"); } } }), /real UI storage broken/);
});

test("diagnostics redact environment secrets, multiline keys, URL credentials/fragments, query tokens and headers", () => {
  const secret = "fixture.$*[]secret-key";
  const text = `${secret} PRIVATE_LINE_123456 PRIVATE_LINE_654321 http://127.0.0.1:1234/#opaque-fragment https://user:pass@example.test/?token=query-secret Authorization: Bearer header-token nonce=fixture-nonce`;
  const out = redactDiagnostic(text, { PAPERCLIP_API_KEY: secret, SSH_PRIVATE_KEY: "PRIVATE_LINE_123456\nPRIVATE_LINE_654321" });
  for (const value of [secret, "PRIVATE_LINE_123456", "PRIVATE_LINE_654321", "opaque-fragment", "user:pass", "query-secret", "header-token", "fixture-nonce"]) assert.ok(!out.includes(value), value);
  assert.ok(out.includes("[REDACTED]"));
});

test("failure receipt reads only isolated launcher state/log and bounds redacted process output", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-smoke-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), artifacts = join(root, "artifacts");
  await mkdir(join(agentDir, "pi-web"), { recursive: true }); await mkdir(artifacts);
  const nonce = "a".repeat(32), token = "b".repeat(32), secret = "fixture-environment-secret";
  await writeFile(join(agentDir, "pi-web/launcher.json"), JSON.stringify({ nonce, url: `http://127.0.0.1:4321/#${token}`, pid: 123, piPid: 456, version: "0.1.21", bridgeVersion: 1, runtimeKind: "desktop" }));
  await writeFile(join(agentDir, "auth.json"), "NEVER_READ_AUTH_FILE");
  await writeFile(join(agentDir, "pi-web/launcher.log"), "old".repeat(40000) + `\nstartup failed: ${nonce} ${token} ${secret}\n`);
  await saveSmokeDiagnostics({ artifacts, agentDir, phase: "first-window", error: new Error(`request http://127.0.0.1:4321/#${token}`),
    stderr: "truncated".repeat(16000) + `\nGPU process failed: ${secret}\n`, env: { SOME_API_KEY: secret } });
  const raw = await readFile(join(artifacts, "smoke-diagnostics.json"), "utf8"); const result = JSON.parse(raw);
  for (const value of [nonce, token, secret, "NEVER_READ_AUTH_FILE", '"url"', '"nonce"']) assert.ok(!raw.includes(value), value);
  assert.equal(result.phase, "first-window"); assert.equal(result.launcher.piPid, 456);
  assert.ok(result.backendLog.includes("startup failed")); assert.ok(result.backendLog.length <= 65536);
  assert.ok(result.electronStderr.includes("GPU process failed")); assert.ok(result.electronStderr.length <= 65536);
  assert.ok(!result.backendLog.startsWith("old"));
});

test("early startup failures without state/log remain diagnosable without reading user directories", async t => {
  const artifacts = await mkdtemp(join(tmpdir(), "pi-early-diagnostics-")); t.after(() => rm(artifacts, { recursive: true, force: true }));
  await saveSmokeDiagnostics({ artifacts, agentDir: join(artifacts, "missing-fixture"), phase: "launch-electron", error: new Error("launch failed") });
  const result = JSON.parse(await readFile(join(artifacts, "smoke-diagnostics.json"), "utf8"));
  assert.equal(result.launcher, null); assert.equal(result.backendLog, null); assert.equal(result.message, "launch failed");
  const source = await readFile(new URL("../../scripts/smoke-desktop.mjs", import.meta.url), "utf8");
  assert.ok(source.indexOf('stage("initial-ui-ready")') < source.indexOf("await page.reload("));
  assert.ok(source.includes('waitUntil: "domcontentloaded"')); assert.ok(!source.includes("--no-sandbox"));
  assert.ok(source.includes("sandbox: true"));
});
