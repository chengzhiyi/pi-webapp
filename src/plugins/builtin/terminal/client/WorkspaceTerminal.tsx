import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { TerminalSession } from "./terminal-session.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { Button } from "../../../../../web/src/ui/shared/primitives/Button.tsx";
import "@xterm/xterm/css/xterm.css";
import css from "./workspace-terminal.module.css";

function failureMessage(reason?: string) {
  switch (reason) {
    case "terminal_shell_unavailable": return t("终端不可用：默认 shell 不存在或不可执行。请修正 SHELL（Windows 为 COMSPEC）后重启应用。", "Terminal unavailable: the default shell is missing or not executable. Correct SHELL (COMSPEC on Windows) and restart the app.");
    case "terminal_workspace_unavailable": return t("终端不可用：工作区目录不存在或不可访问。请切换到有效工作区后新建终端。", "Terminal unavailable: the workspace directory is missing or inaccessible. Select a valid workspace, then open a new terminal.");
    case "terminal_runtime_unavailable": return t("终端不可用：本机终端组件启动失败。请重新安装或修复应用的 node-pty 依赖后重启。", "Terminal unavailable: the native terminal component failed to start. Reinstall or repair the app's node-pty dependency, then restart.");
    case "terminal_limit": return t("终端数量已达上限，请关闭不用的终端后重试。", "Terminal limit reached. Close unused terminals and try again.");
    default: return t("终端不可用，请检查默认 shell 和工作区目录后重新打开。", "Terminal unavailable. Check the default shell and workspace directory, then open a new terminal.");
  }
}

export function WorkspaceTerminal({ model, visible, onNew }: { model: TerminalSession; visible: boolean; onNew(): void }) {
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
      <span>{state.phase === "starting" ? t("正在启动终端…", "Starting terminal…") : state.phase === "disconnected" ? t("连接断开，正在重连…", "Disconnected. Reconnecting…") : state.phase === "exited" ? t(`进程已退出（${state.exitCode}）`, `Process exited (${state.exitCode})`) : failureMessage(state.reason)}</span>
      {(state.phase === "failed" || state.phase === "exited") && <Button size="sm" onClick={onNew}>{t("新建终端", "New terminal")}</Button>}
    </div>}
    <div className={css.screen} ref={container} />
  </section>;
}
