import "./canvas-env.ts";
import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { validateScene, type DiagramScene } from "../contract/diagrams.ts";
export { materialize } from "./scene-adapter.ts";

import { useDiagramTheme } from "./theme.ts";

function native(scene: DiagramScene) { return restoreElements(scene.elements as unknown as ExcalidrawElement[], null); }
export async function thumbnail(scene: DiagramScene, dark = false) {
  await document.fonts.ready;
  const svg = await exportToSvg({ elements: native(scene).filter(e => !e.isDeleted), appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: dark }, files: {}, exportPadding: 32, embedFonts: true });
  return new Blob([svg.outerHTML], { type: "image/svg+xml" });
}
export async function png(scene: DiagramScene, transparent: boolean) {
  await document.fonts.ready;
  return exportToBlob({ elements: native(scene).filter(e => !e.isDeleted), appState: { ...scene.appState, exportBackground: !transparent, exportWithDarkMode: false }, files: {}, mimeType: "image/png", maxWidthOrHeight: 4096 });
}
export default function Canvas({ scene, readOnly, locale, onChange, onError }: { scene: DiagramScene; readOnly: boolean; locale: "zh" | "en"; onChange(scene: DiagramScene): void; onError(message: string): void }) {
  const theme = useDiagramTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const last = useRef(JSON.stringify(scene));
  const lastValid = useRef(scene);
  const refit = useRef(0);
  useEffect(() => () => cancelAnimationFrame(refit.current), []);
  useEffect(() => {
    const fingerprint = JSON.stringify(scene);
    if (api && fingerprint !== last.current) {
      const ids = new Set(lastValid.current.elements.filter(e => !e.isDeleted).map(e => e.id));
      const added = scene.elements.some(e => !e.isDeleted && !ids.has(e.id));
      last.current = fingerprint; lastValid.current = scene;
      api.updateScene({ elements: native(scene), appState: scene.appState, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      // Reveal newly accepted AI content that may be outside the old viewport. Native hand edits
      // already update last.current in onChange, so dragging/typing never triggers this refit.
      if (added) {
        cancelAnimationFrame(refit.current);
        refit.current = requestAnimationFrame(() => api.scrollToContent(api.getSceneElements(), { fitToViewport: true }));
      }
    }
  }, [api, scene]);
  useEffect(() => {
    // Fitting an empty canvas zooms to the native maximum. Start blank drawings at
    // 100%; only fit existing content, without magnifying small drawings above 100%.
    if (!api || !scene.elements.some(e => !e.isDeleted)) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => api.scrollToContent(native(scene), { fitToViewport: true, maxZoom: 1 })); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [api]);
  const change = (elements: readonly OrderedExcalidrawElement[], background: string) => {
    if (readOnly) return;
    try {
      const value = validateScene({ ...scene, elements, appState: { viewBackgroundColor: background } });
      const fingerprint = JSON.stringify(value);
      if (fingerprint !== last.current) { last.current = fingerprint; lastValid.current = value; onChange(value); }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      // Unsupported drops/shortcuts must not leave a different, unsaveable picture on screen.
      queueMicrotask(() => api?.updateScene({ elements: native(lastValid.current), appState: { ...lastValid.current.appState, fileHandle: null }, captureUpdate: CaptureUpdateAction.NEVER }));
    }
  };
  return <Excalidraw excalidrawAPI={setApi} initialData={{ elements: native(scene), appState: { ...scene.appState, currentItemFontFamily: 5, zoom: { value: 1 as NormalizedZoomValue } }, scrollToContent: false }}
    langCode={locale === "zh" ? "zh-CN" : "en"} theme={theme} viewModeEnabled={readOnly} aiEnabled={false} validateEmbeddable={false} handleKeyboardGlobally={false}
    onLinkOpen={(_e, event) => event.preventDefault()} onPaste={() => false}
    UIOptions={{ canvasActions: { export: { saveFileToDisk: true }, toggleTheme: false }, tools: { image: false } }}
    onChange={(elements, state) => change(elements, state.viewBackgroundColor)}>
    <MainMenu>
      <MainMenu.DefaultItems.LoadScene />
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.CommandPalette />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  </Excalidraw>;
}
