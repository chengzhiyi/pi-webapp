import { Fragment, useLayoutEffect, useRef } from "react";
import type { ComposerCommand } from "../../composer-commands.ts";
import { IconCompactOutlineRegular, IconDataOutlineRegular, IconNewChatOutlineRegular, IconPaperclipOutlineRegular } from "../shared/primitives/icons/index.tsx";
import { useAnchoredMaxHeight } from "../primitives/useAnchoredMaxHeight.ts";
import { MenuSurface } from "../shared/primitives/MenuSurface.tsx";
import css from "./MenuView.module.css";
import { localize as t } from "../locale/preference.ts";

export function builtInCommands(): ComposerCommand[] {
  return [
    { name: "file", label: t("文件", "File"), section: "add", icon: IconPaperclipOutlineRegular, menuOnly: false },
    { name: "compact", label: t("压缩", "Compact"), icon: IconCompactOutlineRegular, description: t("压缩当前会话内容", "Compact the current session") },
    { name: "model", label: t("模型", "Model"), icon: IconDataOutlineRegular, description: t("选择本会话使用的模型", "Choose the model for this session") },
    { name: "new", label: t("新会话", "New session"), icon: IconNewChatOutlineRegular, description: t("创建新会话", "Create a new session") },
  ];
}

export function PiCommandMenu({ commands, active, onHover, onPick, grouped = true }: {
  commands: ComposerCommand[];
  grouped?: boolean;
  active: number;
  onHover: (index: number) => void;
  onPick: (command: ComposerCommand) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const maxHeight = useAnchoredMaxHeight(menu, 400, commands.length);
  useLayoutEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, commands.length]);
  return <MenuSurface ref={menu} className={css.menu} data-trigger-menu="" style={{ maxHeight }}>
    <div className={css.viewport} role="listbox" aria-label={t("指令", "Commands")} aria-activedescendant={commands[active] ? `pi-command-${active}` : undefined}>
      {commands.map((command, index) => <Fragment key={`${command.pluginId ?? "pi"}:${command.name}`}>
        {grouped && (index === 0 || command.section !== commands[index - 1]?.section) && <div className={css.sectionTitle} role="presentation">{command.section === "add" ? t("添加", "Add") : t("指令", "Commands")}</div>}
        <button
          id={`pi-command-${index}`}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`${css.item} ${index === active ? css.active : ""}`}
          onMouseDown={(event) => { event.preventDefault(); onPick(command); }}
          onMouseMove={index === active ? undefined : () => onHover(index)}
        >
          {command.icon && <span className={css.itemIcon} aria-hidden><command.icon size={14} /></span>}
          <span className={css.itemName}>{command.label ?? command.name}</span>
          {command.label && command.label.toLowerCase() !== command.name.toLowerCase() && <span className={css.itemAlias}>{command.name}</span>}
          {command.description && <span className={css.itemDescription}>{command.description}</span>}
        </button>
      </Fragment>)}
      {commands.length === 0 && <div className={css.groupTitle}>{t("没有匹配的指令", "No matching commands")}</div>}
    </div>
  </MenuSurface>;
}
