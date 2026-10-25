import type { LoadedPlugin } from "./plugin-manager.ts";
import { ExcalidrawIcon } from "../../../web/src/ui/primitives/ExcalidrawIcon.tsx";

export const OFFICIAL_DRAWINGS = "@chengzhiyi/pi-excalidraw";
const tools = ["excalidraw_create_view", "diagram_create", "diagram_patch"];
/** Metadata/recovery only: never reconstruct a scene from historical model arguments. */
export function drawingRecovery(openManagement: () => void): LoadedPlugin {
  const Recovery = ({locale}: {locale:"zh"|"en"}) => <section role="status" style={{padding:16}}>
    <h3>Excalidraw</h3>
    <p>{locale === "zh" ? "请安装或启用官方 Excalidraw 插件以恢复旧图稿。未从历史工具参数重建图稿；原检查点、工作区文件和浏览器备份均保留。" : "Install or enable the official Excalidraw plugin to recover this drawing. Historical tool arguments are not the latest scene. Checkpoints, workspace files and browser backups are preserved."}</p>
    <button onClick={openManagement}>{locale === "zh" ? "打开插件管理" : "Open plugin management"}</button>
  </section>;
  return {id:OFFICIAL_DRAWINGS,instanceId:"drawing-recovery",definition:{id:OFFICIAL_DRAWINGS,apiVersion:1,activate(){},artifactTools:tools,workbench:{
    apiVersion:1,entry:{label:"Excalidraw",description:{zh:"安装或启用官方绘图插件",en:"Install or enable the official drawing plugin"},kind:"drawing-recovery",icon:ExcalidrawIcon},
    panels:[{kind:"drawing-recovery",component:Recovery}],toolViews:[{tools,component:Recovery}],
    resolvePanel:id=>/^diagram:[\w-]{1,80}$/.test(id)?{kind:"drawing-recovery",contentId:id.slice(8),title:"Excalidraw"}:null,
  }}};
}
