import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { TerminalSession } from "./terminal-session.ts";
import { localize as t } from "./ui/locale/preference.ts";
import { Button } from "./ui/shared/primitives/Button.tsx";
import "@xterm/xterm/css/xterm.css";
import css from "./workspace-terminal.module.css";

export function WorkspaceTerminal({ models, tabId, id, sessionId, visible, onNew }: { models: Map<string, TerminalSession>; tabId: string; id: string; sessionId: string; visible: boolean; onNew(): void }) {
  let model = models.get(tabId);
  if (!model) { model = new TerminalSession(id, sessionId); models.set(tabId, model); }
  const terminal = model;
  const inputLabel = t("终端输入", "Terminal input");
  const container = useRef<HTMLDivElement>(null);
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  useLayoutEffect(() => {
    const node = container.current!; terminal.mount(node);
    const observer = new ResizeObserver(() => terminal.measure()); observer.observe(node);
    const theme = new MutationObserver(() => terminal.measure()); theme.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
    return () => { observer.disconnect(); theme.disconnect(); terminal.element.remove(); };
  }, [model]);
  useLayoutEffect(() => {
    model.terminal.textarea?.setAttribute("aria-label", inputLabel);
    if (visible) { model.measure(); model.terminal.focus(); }
  }, [model, visible, state.phase, inputLabel]);
  return <section className={css.root} data-workspace-terminal={model.id} data-terminal-phase={state.phase}>
    {state.phase !== "connected" && <div className={css.status} role="status">
      <span>{state.phase === "starting" ? t("正在启动终端…", "Starting terminal…") : state.phase === "disconnected" ? t("连接断开，正在重连…", "Disconnected. Reconnecting…") : state.phase === "exited" ? t(`进程已退出（${state.exitCode}）`, `Process exited (${state.exitCode})`) : t("终端不可用，请检查默认 shell 和工作区目录后重新打开。", "Terminal unavailable. Check the default shell and workspace directory, then open a new terminal.")}</span>
      {(state.phase === "failed" || state.phase === "exited") && <Button size="sm" onClick={onNew}>{t("新建终端", "New terminal")}</Button>}
    </div>}
    <div className={css.screen} ref={container} />
  </section>;
}
