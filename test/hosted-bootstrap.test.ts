import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { HostedPluginInstaller } from "../src/host/server/plugins/hosted/installer.ts";
import { archiveMembers } from "../src/host/server/plugins/hosted/archive.ts";
import { satisfiesHost } from "../src/host/server/plugins/hosted/versions.ts";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import piWeb from "../src/host/server/bootstrap/pi-host.ts";
import { closeAgentSession } from "../src/host/server/sessions/lifecycle.ts";

test("actual pi-host defaults to offline hosted coordinator without builtin drawing ownership (retired flag ignored)", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "hosted-bootstrap-"));
  const prior = process.env.PI_CODING_AGENT_DIR, flag = process.env.PI_WEBAPP_HOSTED_EXCALIDRAW;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  let url = "";
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [api => piWeb(api, async address => { url = address; return false; })] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "extension factory must initialize before session binding");
  const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: error => { errors.push(error.error); } });
    assert.deepEqual(errors, []);
    assert.ok(!session.getAllTools().some(tool => tool.name === "diagram_read"));
    const marker = JSON.parse(await readFile(join(cwd, "agent/pi-web/hosted/host-version.json"), "utf8"));
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(marker.version, pkg.version, "persist the exact published host identity, including alpha suffix");
    await t.test("published fixture is denied when incompatible, otherwise bootstrap sends a hot hosted event", { skip: !process.env.HOSTED_EXCALIDRAW_TGZ }, async () => {
      const bytes = await readFile(process.env.HOSTED_EXCALIDRAW_TGZ!);
      const installer = new HostedPluginInstaller({ root: join(cwd, "agent/pi-web/hosted/packages"), hostVersion: marker.version });
      const manifest = JSON.parse(archiveMembers(bytes).find(member => member.path === "package.json")!.data.toString("utf8"));
      const install = () => installer.installArchive("@chengzhiyi/pi-excalidraw", bytes, "sha512-" + createHash("sha512").update(bytes).digest("base64"), "0.1.0");
      if (!satisfiesHost(marker.version, manifest.piWebapp.hostRange)) {
        await assert.rejects(install(), (error: unknown) => (error as { code?: string }).code === "incompatible_plugin");
        assert.deepEqual((await installer.inventory()).versions, {}, "incompatible published plugin must remain uninstalled");
        return;
      }
      await install();
      await session.prompt("/web"); assert.ok(url);
      const address = new URL(url), headers = { Authorization: "Bearer " + address.hash.slice(1), Origin: address.origin, "Content-Type": "application/json" };
      const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 20_000);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const events = await fetch(address.origin + "/api/events", { headers, signal: abort.signal });
        assert.equal(events.status, 200); reader = events.body!.getReader();
        const enabled = await fetch(address.origin + "/api/hosted-plugins/manage", { method: "POST", headers, body: JSON.stringify({ pluginId: "@chengzhiyi/pi-excalidraw", operation: "enable" }) });
        assert.equal(enabled.status, 200); assert.equal((await enabled.json()).plugins[0].enabled, true);
        const decoder = new TextDecoder(); let pending = "", notified = false;
        while (!notified) {
          const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read(); assert.equal(chunk.done, false);
          pending += decoder.decode(chunk.value, { stream: true });
          for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line.trim()) continue;
            const event = JSON.parse(line); assert.notEqual(event.type, "plugins_changed", "Hosted activation must never request a page reload");
            if (event.type === "hosted_plugins_changed") notified = true;
          }
        }
        assert.ok(session.getAllTools().some(tool => tool.name === "diagram_read" && tool.exposure !== "hidden"));
      } finally { clearTimeout(timeout); await reader?.cancel().catch(() => {}); abort.abort(); }
    });
  } finally {
    await closeAgentSession(session, "quit", error => errors.push(error));
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (flag === undefined) delete process.env.PI_WEBAPP_HOSTED_EXCALIDRAW; else process.env.PI_WEBAPP_HOSTED_EXCALIDRAW = flag;
    await rm(cwd, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
});
