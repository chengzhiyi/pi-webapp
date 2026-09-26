import { useRef } from "react";
import type { CommandOption } from "../../pi-bridge.ts";
import { useAnchoredMaxHeight } from "../primitives/useAnchoredMaxHeight.ts";
import css from "./MenuView.module.css";
import { localize as t } from "../locale/preference.ts";

export function builtInCommands(): CommandOption[] {
  return [
    { name: "compact", description: t("压缩当前会话内容", "Compact the current session") },
    { name: "model", description: t("选择本会话使用的模型", "Choose the model for this session") },
    { name: "new", description: t("创建新会话", "Create a new session") },
  ];
}

export function PiCommandMenu({ commands, active, onHover, onPick }: {
  commands: CommandOption[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: CommandOption) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const maxHeight = useAnchoredMaxHeight(menu, 400, commands.length);
  return <div ref={menu} className={css.menu} data-trigger-menu="" style={{ maxHeight }}>
    <div className={css.viewport} role="listbox" aria-label={t("指令", "Commands")} aria-activedescendant={commands[active] ? `pi-command-${active}` : undefined}>
      <div className={css.groupTitle} role="presentation">{t("指令", "Commands")}</div>
      {commands.map((command, index) => <button
        key={command.name}
        id={`pi-command-${index}`}
        type="button"
        role="option"
        aria-selected={index === active}
        className={`${css.item} ${index === active ? css.active : ""}`}
        onMouseDown={(event) => { event.preventDefault(); onPick(command); }}
        onMouseMove={() => onHover(index)}
      >
        <span className={css.itemName}>{command.name}</span>
        {command.description && <span className={css.itemDescription}>{command.description}</span>}
      </button>)}
      {commands.length === 0 && <div className={css.groupTitle}>{t("没有匹配的指令", "No matching commands")}</div>}
    </div>
  </div>;
}
