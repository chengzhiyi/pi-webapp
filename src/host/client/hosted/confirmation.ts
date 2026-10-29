export type ConfirmationOperation = "uninstall" | "disable" | "update";

/** Copy follows the operation; the caller still executes the existing save barrier. */
export function managementConfirmation(operation: ConfirmationOperation, locale: "zh" | "en", name: string) {
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  if (operation === "uninstall") return {
    title: t(`卸载 ${name}？`, `Uninstall ${name}?`),
    description: t("保存成功后将关闭相关视图并卸载插件。工作区文件和插件数据会保留，可重新安装后继续使用；保存失败时不会卸载。", "After saving successfully, related views close and the plugin is uninstalled. Workspace files and plugin data are retained for reinstallation. A failed save stops uninstallation."),
    confirm: t("卸载", "Uninstall"),
  };
  if (operation === "disable") return {
    title: t(`停用 ${name}？`, `Disable ${name}?`),
    description: t("保存成功后将关闭相关视图并停用插件。插件仍保持安装，工作区文件和插件数据会保留；保存失败时不会停用。", "After saving successfully, related views close and the plugin is disabled. It remains installed, with workspace files and plugin data retained. A failed save stops disabling."),
    confirm: t("停用", "Disable"),
  };
  return {
    title: t(`立即更新 ${name} 并重新打开？`, `Update ${name} and reopen now?`),
    description: t("全部视图保存成功后将更新插件并重新打开视图，撤销/重做历史会清空。工作区文件和插件数据会保留；保存失败时不会更新。", "After all views save successfully, update the plugin and reopen its views. Undo/redo history will be cleared. Workspace files and plugin data are retained. A failed save stops the update."),
    confirm: t("更新并重新打开", "Update and reopen"),
  };
}
