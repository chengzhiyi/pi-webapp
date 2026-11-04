import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import type { CodeEditorHandle } from "./code-editor.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

let editorModule: Promise<typeof import("./code-editor.ts")> | undefined;
const loadEditor = () => editorModule ??= import("./code-editor.ts");

/**
 * Highlighted, editable source. `text` is the document the parent wants shown; edits are
 * reported through `onChange` and only become `text` again when the parent passes them back.
 */
export function CodeEditor({ text, filename, label, reveal, autoFocus, onChange, onSave }: {
  text: string; filename: string; label: string; reveal?: { line: number }; autoFocus?: boolean;
  onChange(text: string): void; onSave(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<CodeEditorHandle>();
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onChange, onSave });
  useLayoutEffect(() => { callbacks.current = { onChange, onSave }; });
  const initial = useRef(text);
  useEffect(() => {
    let created: CodeEditorHandle | undefined;
    let cancelled = false;
    void loadEditor().then(({ createCodeEditor }) => {
      if (cancelled || !host.current) return;
      created = createCodeEditor(host.current, {
        text: initial.current, filename, label,
        onChange: value => callbacks.current.onChange(value),
        onSave: () => callbacks.current.onSave(),
      });
      setEditor(created);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; created?.destroy(); };
  }, [filename, label]);
  // Saves and outside reloads change the parent's text; typing already matches it.
  useEffect(() => { editor?.setText(text); }, [editor, text]);
  useEffect(() => { if (editor && reveal) editor.reveal(reveal.line); }, [editor, reveal]);
  useEffect(() => { if (editor && autoFocus) editor.focus(); }, [editor, autoFocus]);
  if (failed) return <p className={css.state} role="status">{t("编辑器加载失败，请重新读取文件。", "The editor could not load. Reload the file to try again.")}</p>;
  return <div ref={host} className={css.codeEditor} aria-busy={!editor}>
    {!editor && <p className={css.state}>{t("正在打开编辑器…", "Opening the editor…")}</p>}
  </div>;
}
