import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileTypeIcon } from "../../../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { workspaceFilesApi } from "./workspace-files-api.ts";
import type { WorkspaceFileSearch } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

/** "?text" searches inside files; anything else filters paths. */
export function parseQuery(query: string): { mode: "name" | "content"; text: string } {
  return query.startsWith("?") ? { mode: "content", text: query.slice(1).trim() } : { mode: "name", text: query.trim() };
}

function highlight(text: string, needle: string): ReactNode {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (!needle || at < 0) return text;
  return <>{text.slice(0, at)}<mark className={css.match}>{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}

/** Arrow keys move between results; Up from the first returns to the search box. */
export function moveInResults(event: KeyboardEvent<HTMLElement>, input: HTMLInputElement | null) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-search-result]")];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? buttons[index + 1] : index <= 0 ? input : buttons[index - 1];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** Remount (key) to search again after the workspace changed. */
export function FileSearchResults({ sessionId, query, input, onOpen }: {
  sessionId: string; query: string; input: HTMLInputElement | null; onOpen(path: string, line?: number): void;
}) {
  const { mode, text } = parseQuery(query);
  const [result, setResult] = useState<WorkspaceFileSearch | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  useEffect(() => {
    if (!text || (mode === "content" && text.length < 2)) { setResult(null); setState("idle"); return; }
    const controller = new AbortController();
    setState("loading");
    // Typing settles before the workspace is scanned.
    const timer = window.setTimeout(() => {
      void workspaceFilesApi.search(sessionId, text, mode, controller.signal).then(value => {
        if (!controller.signal.aborted) { setResult(value); setState("idle"); }
      }).catch(() => { if (!controller.signal.aborted) setState("error"); });
    }, mode === "content" ? 300 : 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [sessionId, mode, text]);

  if (!text || (mode === "content" && text.length < 2)) {
    return mode === "content" ? <p className={css.state}>{t("输入至少 2 个字符，在文件内容中搜索。", "Type at least 2 characters to search file contents.")}</p> : null;
  }
  if (state === "error") return <p className={css.state} role="status">{t("搜索失败，请重试。", "Search failed. Try again.")}</p>;
  if (!result || result.kind !== mode) return <p className={css.state} role="status">{t("正在搜索…", "Searching…")}</p>;
  if (!result.results.length) return <p className={css.state} role="status">{t("没有匹配的结果。", "No matches.")}</p>;
  const more = result.truncated && <p className={css.state}>{t("结果太多，只显示一部分。请输入更具体的内容。", "Showing some results only. Type something more specific.")}</p>;
  if (result.kind === "name") {
    return <div>
      <ul className={css.results} aria-label={t("匹配的文件", "Matching files")} onKeyDown={event => moveInResults(event, input)}>
        {result.results.map(({ path }) => {
          const slash = path.lastIndexOf("/");
          return <li key={path}><button type="button" data-search-result className={css.result} title={path} onClick={() => onOpen(path)}>
            <FileTypeIcon path={path} size={16} />
            <span className={css.name}>{highlight(path.slice(slash + 1), text)}</span>
            {slash > 0 && <span className={css.resultDirectory}>{path.slice(0, slash)}</span>}
          </button></li>;
        })}
      </ul>
      {more}
    </div>;
  }
  const groups = new Map<string, typeof result.results>();
  for (const hit of result.results) groups.set(hit.path, [...groups.get(hit.path) ?? [], hit]);
  return <div>
    <ul className={css.results} aria-label={t("内容匹配", "Content matches")} onKeyDown={event => moveInResults(event, input)}>
      {[...groups].map(([path, hits]) => <li key={path}>
        <div className={css.resultFile} title={path}><FileTypeIcon path={path} size={14} /><span className={css.name}>{path}</span><span className={css.resultCount}>{hits.length}</span></div>
        <ul>{hits.map(hit => <li key={hit.line}>
          <button type="button" data-search-result className={css.resultLine} aria-label={t(`${path} 第 ${hit.line} 行：${hit.text}`, `${path} line ${hit.line}: ${hit.text}`)} onClick={() => onOpen(path, hit.line)}>
            <span className={css.lineNumber}>{hit.line}</span><span className={css.lineText}>{highlight(hit.text, text)}</span>
          </button>
        </li>)}</ul>
      </li>)}
    </ul>
    {more}
  </div>;
}
