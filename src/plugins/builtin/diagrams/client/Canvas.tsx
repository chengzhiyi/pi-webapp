import "./canvas-env.ts";
import { useEffect, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, exportToBlob, exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { validateScene, type DiagramScene } from "../contract/diagrams.ts";
export { materialize } from "./scene-adapter.ts";

function native(scene: DiagramScene) { return restoreElements(scene.elements as unknown as ExcalidrawElement[], null); }
export async function thumbnail(scene: DiagramScene) {
  await document.fonts.ready;
  const svg = await exportToSvg({ elements: native(scene).filter(e => !e.isDeleted), appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false }, files: {}, exportPadding: 32, embedFonts: true });
  return new Blob([svg.outerHTML], { type: "image/svg+xml" });
}
export async function png(scene: DiagramScene, transparent: boolean) {
  await document.fonts.ready;
  return exportToBlob({ elements: native(scene).filter(e => !e.isDeleted), appState: { ...scene.appState, exportBackground: !transparent, exportWithDarkMode: false }, files: {}, mimeType: "image/png", maxWidthOrHeight: 4096 });
}
export default function Canvas({ scene, readOnly, locale, onChange, onError, onSave, onOpen, onImport, onRecover, onExport, onDownload, saveStatus }: { scene: DiagramScene; readOnly: boolean; locale: "zh" | "en"; onChange(scene: DiagramScene): void; onError(message: string): void; onSave(): void; onOpen(): void; onImport(): void; onRecover(): void; saveStatus: string; onExport(transparent: boolean): void; onDownload(): void }) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const last = useRef(JSON.stringify(scene));
  const lastValid = useRef(scene);
  useEffect(() => {
    const fingerprint = JSON.stringify(scene);
    if (api && fingerprint !== last.current) { last.current = fingerprint; lastValid.current = scene; api.updateScene({ elements: native(scene), appState: scene.appState, captureUpdate: CaptureUpdateAction.IMMEDIATELY }); }
  }, [api, scene]);
  useEffect(() => {
    if (!api) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => api.scrollToContent(native(scene), { fitToViewport: true })); });
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
      queueMicrotask(() => api?.updateScene({ elements: native(lastValid.current), appState: lastValid.current.appState, captureUpdate: CaptureUpdateAction.NEVER }));
    }
  };
  return <Excalidraw excalidrawAPI={setApi} initialData={{ elements: native(scene), appState: { ...scene.appState, currentItemFontFamily: 5 }, scrollToContent: true }}
    langCode={locale === "zh" ? "zh-CN" : "en"} viewModeEnabled={readOnly} aiEnabled={false} validateEmbeddable={false} handleKeyboardGlobally={false}
    onLinkOpen={(_e, event) => event.preventDefault()} onPaste={() => false}
    UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false }, tools: { image: false } }}
    onChange={(elements, state) => change(elements, state.viewBackgroundColor)}>
    <MainMenu>
      <MainMenu.Item disabled>{saveStatus}</MainMenu.Item>
      <MainMenu.Item onSelect={onOpen}>{t("打开工作区图稿", "Open workspace diagram")}</MainMenu.Item>
      <MainMenu.Item onSelect={onImport}>{t("导入源文件", "Import source")}</MainMenu.Item>
      <MainMenu.Item onSelect={onRecover}>{t("恢复本地备份", "Recover local backup")}</MainMenu.Item>
      <MainMenu.Item onSelect={onSave}>{t("保存 / 另存到工作区", "Save / Save as to workspace")}</MainMenu.Item>
      <MainMenu.Item onSelect={onDownload}>{t("下载源文件", "Download source")}</MainMenu.Item>
      <MainMenu.Separator />
      <MainMenu.Item onSelect={() => onExport(false)}>{t("导出 PNG", "Export PNG")}</MainMenu.Item>
      <MainMenu.Item onSelect={() => onExport(true)}>{t("导出透明底 PNG", "Export transparent PNG")}</MainMenu.Item>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.ToggleTheme /><MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  </Excalidraw>;
}
