import type { LoadedPlugin } from "./plugin-manager.ts";
import { Button } from "../../../web/src/ui/primitives/Button.tsx";
import css from "./hosted/reconciliation.module.css";

export const OFFICIAL_DRAWINGS = "@chengzhiyi/pi-excalidraw";
const tools = ["excalidraw_create_view", "diagram_create", "diagram_patch"];
/** Metadata/recovery only: never reconstruct a scene from historical model arguments. */
export function drawingRecovery(openManagement: () => void): LoadedPlugin {
  const Recovery = ({locale}: {locale:"zh"|"en"}) => <section role="status" className={css.history}>
    <h3>Excalidraw</h3>
    <p>{locale === "zh" ? "Excalidraw 编辑器当前不可用。请在插件管理中检查安装、启用状态及运行时诊断。未从历史工具参数重建图稿；原检查点、工作区文件和浏览器备份均保留。" : "The Excalidraw editor is currently unavailable. Check installation, enablement and runtime diagnostics in plugin management. Historical tool arguments are not the latest scene. Checkpoints, workspace files and browser backups are preserved."}</p>
    <Button variant="outline" onClick={openManagement}>{locale === "zh" ? "打开插件管理" : "Open plugin management"}</Button>
  </section>;
  return {id:OFFICIAL_DRAWINGS,instanceId:"drawing-recovery",definition:{id:OFFICIAL_DRAWINGS,apiVersion:1,activate(){},artifactTools:tools,workbench:{
    apiVersion:1,
    panels:[{kind:"drawing-recovery",component:Recovery}],toolViews:[{tools,component:Recovery}],
    resolvePanel:id=>/^diagram:[\w-]{1,80}$/.test(id)?{kind:"drawing-recovery",contentId:id.slice(8),title:"Excalidraw"}:null,
  }}};
}
