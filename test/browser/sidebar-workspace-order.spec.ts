import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let script: string;
test.beforeAll(async () => {
  // Exercise the real browser hook without a server or a prebuilt web/dist.
  const result = await build({
    bundle: true, write: false,
    define: { "process.env.NODE_ENV": '"development"' },
    stdin: {
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      contents: `
        import { act, createElement, useEffect } from "react";
        import { createRoot } from "react-dom/client";
        import { usePiBridge } from "./src/host/client/pi-bridge.ts";

        globalThis.IS_REACT_ACT_ENVIRONMENT = true;
        const streams = [], queries = [], connections = [];
        const list = (id) => ({ items: [{ id, path: "/" + id, title: id }], activeId: id, sessions: [] });
        // Keep JSON delivery in the same explicit act() batch as the fetch release.
        const json = (value) => Object.assign(new Response(), { json: async () => value });
        let readerReady;
        window.fetch = async (path) => {
          if (path === "/api/events") {
            const response = new Response(new ReadableStream({ start(controller) { streams.push(controller); } }));
            const getReader = response.body.getReader.bind(response.body);
            response.body.getReader = () => { readerReady?.(); return getReader(); };
            return response;
          }
          if (path === "/api/workspaces") {
            return new Promise(resolve => queries.push(id => resolve(json(list(id)))));
          }
          if (path === "/api/plugin-management") return json({ items: [] });
          if (path === "/api/directory/capability") return json({ kind: "browse" });
          return json([]);
        };

        // Advance only the reconnect timer, keeping EOF and reconnect in one React batch.
        const setTimeout = window.setTimeout.bind(window);
        let retry;
        window.setTimeout = (callback, ms, ...args) => {
          if (ms !== 1500) return setTimeout(callback, ms, ...args);
          retry(callback);
        };
        function Probe() {
          const { connection, workspaces } = usePiBridge();
          useEffect(() => { connections.push(connection); }, [connection]);
          return createElement("output", null, workspaces.activeId ?? "none");
        }
        const root = createRoot(document.getElementById("root"));
        window.sidebarFixture = {
          mount: () => act(async () => { root.render(createElement(Probe)); }),
          live: (id) => act(async () => {
            const event = JSON.stringify({ type: "workspaces", value: list(id) });
            streams.at(-1).enqueue(new TextEncoder().encode(event + "\\n"));
          }),
          query: (index, id) => act(async () => { queries[index](id); }),
          reconnect: () => act(async () => {
            const ready = new Promise(resolve => { retry = resolve; });
            const reading = new Promise(resolve => { readerReady = resolve; });
            streams.at(-1).close();
            (await ready)();
            await reading;
          }),
          connections: () => connections.slice(),
        };
      `,
    },
  });
  script = result.outputFiles[0]!.text;
});

interface SidebarFixture {
  mount(): Promise<void>;
  live(id: string): Promise<void>;
  query(index: number, id: string): Promise<void>;
  reconnect(): Promise<void>;
  connections(): string[];
}
declare global { interface Window { sidebarFixture: SidebarFixture } }

async function mount(page: Page) {
  await page.route("http://sidebar.test/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://sidebar.test/#test-token");
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.sidebarFixture.mount());
  return page.locator("output");
}

test("a late bootstrap cannot overwrite the initial live list", async ({ page }) => {
  const list = await mount(page);
  await page.evaluate(() => window.sidebarFixture.live("initial-live"));
  await expect(list).toHaveText("initial-live");
  await page.evaluate(() => window.sidebarFixture.query(0, "stale-bootstrap"));
  await expect(list).toHaveText("initial-live");
});

test("batched reconnect retires the previous query and starts a fresh fallback", async ({ page }) => {
  const list = await mount(page);
  await page.evaluate(() => window.sidebarFixture.reconnect());
  expect(await page.evaluate(() => window.sidebarFixture.connections())).toEqual(["connecting", "connected"]);
  // Neither stream has provided a list: only generation ownership can reject this result.
  await page.evaluate(() => window.sidebarFixture.query(0, "old-generation"));
  await expect(list).toHaveText("none");
  await page.evaluate(() => window.sidebarFixture.query(1, "new-generation"));
  await expect(list).toHaveText("new-generation");
});

test("legacy startup fallback works and a live list does not disable fallback on reconnect", async ({ page }) => {
  const list = await mount(page);
  await page.evaluate(() => window.sidebarFixture.query(0, "legacy-startup"));
  await expect(list).toHaveText("legacy-startup");
  await page.evaluate(() => window.sidebarFixture.live("live-update"));
  await expect(list).toHaveText("live-update");
  await page.evaluate(() => window.sidebarFixture.reconnect());
  await expect(list).toHaveText("live-update");
  await page.evaluate(() => window.sidebarFixture.query(1, "legacy-reconnect"));
  await expect(list).toHaveText("legacy-reconnect");
});
