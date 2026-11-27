import { test } from "node:test";
import assert from "node:assert/strict";
import { allowPreviewRequest, normalizePreviewInput, previewAddress, previewBounds, resolvePreviewInput } from "../web-preview-policy.mjs";

const backend = "http://127.0.0.1:19327/#private-token";

test("the address bar accepts domains, developer URLs, LAN names and IPv4/IPv6", () => {
  for (const [input, expected] of [
    ["  localhost:5173/demo?a=1#test  ", "http://localhost:5173/demo?a=1#test"],
    ["127.0.0.1:8787", "http://127.0.0.1:8787/"],
    ["[::1]:3000/foo", "http://[::1]:3000/foo"],
    ["https://localhost:3443/", "https://localhost:3443/"],
    ["example.com/path?q=value#hash", "https://example.com/path?q=value#hash"],
    ["例子.测试", "https://xn--fsqu00a.xn--0zwm56d/"],
    ["http://example.com/", "http://example.com/"],
    ["192.168.1.2:3000", "http://192.168.1.2:3000/"],
    ["router.local", "http://router.local/"],
    ["devbox:4000", "http://devbox:4000/"],
    ["example.com:8080/", "http://example.com:8080/"],
    ["https://example.com:8443/", "https://example.com:8443/"],
  ]) {
    assert.equal(normalizePreviewInput(input), expected, input);
    assert.equal(previewAddress(expected, backend), expected, input);
  }
});

test("the address bar rejects relative paths, invalid ports, credentials and non-web schemes", () => {
  for (const input of ["", "hello world", "/tmp/test.html", "http:example.com", "http:////example.com", "example.com:100000",
    "user:pass@example.com", "http://user:pass@127.0.0.1:3000/", "http://127.0.0.1:3000\\path", "http://local\nhost:3000/",
    "file:///tmp/test.html", "javascript:void(0)", "javascript:123", "data:text/html,test", "ws://localhost:5173/",
    "pi-desktop://launcher-handoff", 3000, null]) {
    assert.equal(normalizePreviewInput(input), null, String(input));
  }
  assert.equal(previewAddress("localhost:5173/", backend), null);
});

test("the omnibox opens website addresses and encodes only submitted search terms for Google", () => {
  for (const [address, expected] of [["example.com", "https://example.com/"], ["localhost", "http://localhost/"],
    ["localhost:5173/?a=1", "http://localhost:5173/?a=1"], ["192.168.1.2:3000", "http://192.168.1.2:3000/"],
    ["devbox:4000", "http://devbox:4000/"], ["router.local", "http://router.local/"], ["[::1]:3273", "http://[::1]:3273/"],
    ["http://devbox", "http://devbox/"], ["example.test/path with space", "http://example.test/path%20with%20space"]]) {
    assert.equal(resolvePreviewInput(address), expected);
  }
  for (const [input, expected] of [["Electron", "Electron"], ["  中文 搜索 + & #  ", "中文 搜索 + & #"],
    ["react.dev useEffect", "react.dev useEffect"], ["? site:github.com pi-webapp", "site:github.com pi-webapp"],
    ["? example.com", "example.com"]]) {
    const url = new URL(resolvePreviewInput(input));
    assert.equal(url.origin + url.pathname, "https://www.google.com/search");
    assert.deepEqual([...url.searchParams], [["q", expected]]);
    assert.equal(url.hash, "");
  }
  for (const invalid of ["?", "?   ", "https://", "https://bad host/", "example.com:65536/", "file:///tmp/private note",
    "/tmp/private note", "C:/private note", "javascript: alert(1)", "user:password@example.com", "http://user:password@example.com",
    "localhost:3000 bad", "wait\nnow"]) assert.equal(resolvePreviewInput(invalid), null, invalid);
  assert.equal(previewAddress(resolvePreviewInput("localhost:19327"), backend), null);
});

test("Pi's backend port is denied for any hostname or transport, including on redirects and subresources", () => {
  for (const url of [backend, "http://localhost:19327/path", "https://[::1]:19327/", "http://2130706433:19327/",
    "http://devbox.local:19327/", "http://192.168.1.2:19327/", "https://example.com:19327/"]) {
    assert.equal(previewAddress(url, backend), null, url);
    assert.equal(allowPreviewRequest(url, "mainFrame", backend), false, url);
    assert.equal(allowPreviewRequest(url, "xhr", backend), false, url);
  }
  assert.equal(allowPreviewRequest("wss://localhost:19327/", "webSocket", backend), false);
  assert.equal(previewAddress("http://localhost/", "http://127.0.0.1/#private-token"), null);
});

test("guest network policy permits web assets and WebSockets, but not non-web top-level documents", () => {
  assert.equal(allowPreviewRequest("http://localhost:5173/styles.css", "stylesheet", backend), true);
  assert.equal(allowPreviewRequest("ws://localhost:5173/", "webSocket", backend), true);
  assert.equal(allowPreviewRequest("data:image/gif;base64,AA", "image", backend), true);
  assert.equal(allowPreviewRequest("https://example.com/public.js", "script", backend), true);
  assert.equal(allowPreviewRequest("blob:http://localhost:5173/test", "mainFrame", backend), false);
  assert.equal(allowPreviewRequest("file:///tmp/test.html", "mainFrame", backend), false);
});

test("native bounds round inward, scale with zoom, and clamp to the host viewport", () => {
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(previewBounds({ x: 10.2, y: 5.1, width: 400, height: 200 }, viewport, 1.25), { x: 13, y: 7, width: 499, height: 249 });
  assert.deepEqual(previewBounds({ x: -100, y: 20, width: 1000, height: 900 }, viewport, 1), { x: 0, y: 20, width: 800, height: 580 });
  for (const bounds of [null, { x: 0, y: 0, width: 0, height: 5 }, { x: 0, y: NaN, width: 2, height: 3 }, { x: 800, y: 0, width: 3, height: 5 }]) {
    assert.equal(previewBounds(bounds, viewport, 1), null);
  }
});
