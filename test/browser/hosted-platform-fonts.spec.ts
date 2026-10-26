import { test, expect } from "@playwright/test";
import { boxes, hostedParity } from "../helpers/hosted-parity.ts";

test("A23: actual hosted iframe loads packaged font faces without external font access", async ({ page }, info) => {
  test.skip(!process.env.HOSTED_EXCALIDRAW_TGZ, "Exact archive required");
  test.setTimeout(100_000);
  const h = await hostedParity(page);
  const fontResponses: { url: string; status: number }[] = [];
  page.on("response", response => { if (/\.(woff2?|ttf)(?:\?|$)/i.test(response.url())) fontResponses.push({ url: new URL(response.url()).pathname, status: response.status() }); });
  try {
    await h.tool("excalidraw_create_view", boxes());
    await page.goto(h.bridge.url); const editor = await h.open();
    // Explicitly load the actual declared faces with Latin and CJK samples. A generic
    // document.fonts.check can succeed via fallback, so inspect real FontFace status too.
    const fonts = await editor.locator("body").evaluate(async () => {
      const declared = Array.from(document.fonts);
      for (const face of declared) await document.fonts.load(`20px ${face.family}`, "Drawing 中文");
      await document.fonts.ready;
      return Array.from(document.fonts).map(face => ({ family: face.family, status: face.status }));
    });
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter(face => face.status === "loaded").length).toBeGreaterThan(0);
    expect(fonts.filter(face => face.status === "error")).toEqual([]);
    expect(fontResponses.length).toBeGreaterThan(0);
    expect(fontResponses.every(response => response.status === 200)).toBe(true);
    expect(h.external).toEqual([]); expect(h.errors).toEqual([]);
    await info.attach("actual-font-faces", { body: JSON.stringify({ fonts, fontResponses }), contentType: "application/json" });
  } finally { await h.close(); }
});
