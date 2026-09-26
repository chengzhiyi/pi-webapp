import { useRef } from "react";
import type { CommandOption } from "../../pi-bridge.ts";
import { useAnchoredMaxHeight } from "../primitives/useAnchoredMaxHeight.ts";
import css from "./MenuView.module.css";

export const builtInCommands: CommandOption[] = [
  { name: "compact", description: "压缩当前会话内容" },
  { name: "model", description: "选择本会话使用的模型" },
  { name: "new", description: "创建新会话" },
];

export function PiCommandMenu({ commands, active, onHover, onPick }: {
  commands: CommandOption[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: CommandOption) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const maxHeight = useAnchoredMaxHeight(menu, 400, commands.length);
  return <div ref={menu} className={css.menu} data-trigger-menu="" style={{ maxHeight }}>
    <div className={css.viewport} role="listbox" aria-label="指令" aria-activedescendant={commands[active] ? `pi-command-${active}` : undefined}>
      <div className={css.groupTitle} role="presentation">指令</div>
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
      {commands.length === 0 && <div className={css.groupTitle}>没有匹配的指令</div>}
    </div>
  </div>;
}
