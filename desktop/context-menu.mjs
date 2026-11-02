import { localize as t } from "./locale.mjs";

/** Native editing actions keep Node and clipboard access out of the sandboxed renderer. */
export function showContextMenu(params, { Menu, clipboard, window }) {
  const template = [];
  if (params.linkURL) template.push({ label: t("复制链接地址", "Copy Link Address"), action: "copy-link" });
  if (params.isEditable) {
    if (template.length) template.push({ type: "separator" });
    template.push({ role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" });
  } else if (params.selectionText) {
    if (template.length) template.push({ type: "separator" });
    template.push({ role: "copy" });
  }
  if (!template.length) return false;
  const items = template.map(item => item.action === "copy-link"
    ? { label: item.label, click: () => clipboard.writeText(params.linkURL) }
    : item);
  Menu.buildFromTemplate(items).popup({ window });
  return true;
}
