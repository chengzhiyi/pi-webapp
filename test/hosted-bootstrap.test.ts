import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import piWeb from "../src/host/server/bootstrap/pi-host.ts";
import { closeAgentSession } from "../src/host/server/sessions/lifecycle.ts";

test("actual pi-host opt-in starts offline coordinator from TUI lifecycle without builtin diagram ownership", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hosted-bootstrap-"));
  const prior = process.env.PI_CODING_AGENT_DIR, flag = process.env.PI_WEBAPP_HOSTED_EXCALIDRAW;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent"); process.env.PI_WEBAPP_HOSTED_EXCALIDRAW = "1";
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [api => piWeb(api, async () => false)] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: error => { errors.push(error.error); } });
    assert.deepEqual(errors, []);
    assert.ok(!session.getAllTools().some(tool => tool.name === "diagram_read"));
    const marker = JSON.parse(await readFile(join(cwd, "agent/pi-web/hosted/host-version.json"), "utf8"));
    assert.equal(marker.version, "0.1.29");
  } finally {
    await closeAgentSession(session, "quit", error => errors.push(error));
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    if (flag === undefined) delete process.env.PI_WEBAPP_HOSTED_EXCALIDRAW; else process.env.PI_WEBAPP_HOSTED_EXCALIDRAW = flag;
    await rm(cwd, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
});
