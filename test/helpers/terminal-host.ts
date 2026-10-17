import { tmpdir } from "node:os";
import type { BridgeHost } from "../../extension/bridge.ts";
import type { SessionView } from "../../extension/view.ts";

export function terminalHost(cwd = tmpdir()) {
  let session: SessionView = { schemaVersion: 1, sessionId: "terminal-a", cwd, name: "Terminal A", model: "example/model", thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages: [], pluginEntries: [] };
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); }, async workspaces() { return { items: [], activeId: null, sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  return { host, switchSession(id: string, cwd = session.cwd) { session = { ...session, sessionId: id, cwd }; return session; } };
}

