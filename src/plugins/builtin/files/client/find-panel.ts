/**
 * The editor's Find box (Mod-F): one field, a match count, previous/next and close, floating
 * over the top-right of the editor instead of CodeMirror's full-width form under it.
 */
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";

/** Counting stops here, so a one-letter query in a huge file stays cheap per keystroke. */
const COUNT_LIMIT = 999;
const SVG = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
  previous: `<svg ${SVG}><path d="M4 10l4-4 4 4"/></svg>`,
  next: `<svg ${SVG}><path d="M4 6l4 4 4-4"/></svg>`,
  close: `<svg ${SVG}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`,
};

function button(name: keyof typeof ICONS, label: string, run: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-find-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.innerHTML = ICONS[name];
  // Keep focus in the field, so Enter keeps stepping after a click.
  element.addEventListener("mousedown", event => event.preventDefault());
  element.addEventListener("click", run);
  return element;
}

/** "3/12" when the selection is a match, "12" when it is not, "No results" for none. */
function matchLabel(view: EditorView, query: SearchQuery): string {
  if (!query.search || !query.valid) return "";
  const { from, to } = view.state.selection.main;
  let count = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    count++;
    if (match.value.from === from && match.value.to === to) current = count;
    if (count > COUNT_LIMIT) return current ? `${current}/${COUNT_LIMIT}+` : `${COUNT_LIMIT}+`;
  }
  if (!count) return t("无结果", "No results");
  return current ? `${current}/${count}` : String(count);
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-find";
  dom.setAttribute("role", "search");
  const input = document.createElement("input");
  input.className = "cm-find-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = t("查找", "Find");
  input.setAttribute("aria-label", t("在文件中查找", "Find in file"));
  // CodeMirror focuses and selects this field when Mod-F is pressed with the box already open.
  input.setAttribute("main-field", "true");
  input.value = getSearchQuery(view.state).search;
  const count = document.createElement("span");
  count.className = "cm-find-count";
  count.setAttribute("aria-live", "polite");
  const refresh = () => { count.textContent = matchLabel(view, getSearchQuery(view.state)); };
  const step = (backward: boolean) => { if (backward) findPrevious(view); else findNext(view); };

  input.addEventListener("input", () => {
    const query = new SearchQuery({ ...getSearchQuery(view.state), search: input.value });
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (!query.search || !query.valid) return;
    // Type-ahead: jump to the first match from where the selection starts, not past it.
    const start = view.state.selection.main.from;
    const match = query.getCursor(view.state, start).next();
    const found = match.done ? query.getCursor(view.state, 0, start).next() : match;
    if (!found.done) view.dispatch({ selection: { anchor: found.value.from, head: found.value.to }, scrollIntoView: true, userEvent: "select.search" });
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey); }
    else if (event.key === "Escape") { event.preventDefault(); closeSearchPanel(view); view.focus(); }
  });

  dom.append(input, count,
    button("previous", t("上一个匹配（Shift+Enter）", "Previous match (Shift+Enter)"), () => step(true)),
    button("next", t("下一个匹配（Enter）", "Next match (Enter)"), () => step(false)),
    button("close", t("关闭（Esc）", "Close (Esc)"), () => { closeSearchPanel(view); view.focus(); }));
  refresh();
  return {
    dom,
    top: true,
    mount() { input.focus(); input.select(); },
    update(update: ViewUpdate) {
      const query = getSearchQuery(update.state);
      // Mod-F over a selection replaces the query from outside the field.
      if (query.search !== input.value && update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery)))) input.value = query.search;
      if (update.docChanged || update.selectionSet || query !== getSearchQuery(update.startState)) refresh();
    },
  };
}

const findTheme = EditorView.theme({
  // Float the panel instead of stacking it above the scroller; the editor is position: relative.
  ".cm-panels.cm-panels-top": { position: "absolute", top: "8px", right: "16px", left: "auto", border: "none", backgroundColor: "transparent", zIndex: "300" },
  ".cm-find": {
    display: "flex", alignItems: "center", gap: "2px", boxSizing: "border-box", width: "min(340px, calc(100vw - 48px))", padding: "6px",
    border: "0.5px solid var(--dsw-alias-border-l2)", borderRadius: "var(--dsw-radius-md)",
    backgroundColor: "var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-1))", boxShadow: "var(--dsw-elevation-panel)",
    fontFamily: "var(--ds-font-family, inherit)", fontSize: "12.5px", color: "var(--dsw-alias-label-primary)",
  },
  ".cm-find-input": {
    flex: "1", minWidth: "0", height: "28px", boxSizing: "border-box", margin: "0 4px 0 0", padding: "0 10px",
    border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: "var(--dsw-radius-sm)",
    backgroundColor: "var(--dsw-alias-bg-base, transparent)", color: "inherit", font: "inherit", outline: "none",
  },
  ".cm-find-input:focus": { borderColor: "var(--dsw-alias-border-l1)" },
  ".cm-find-input::placeholder": { color: "var(--dsw-alias-label-tertiary)" },
  ".cm-find-count": { flex: "none", minWidth: "0", padding: "0 6px 0 2px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  ".cm-find-count:empty": { display: "none" },
  ".cm-find-button": {
    display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "28px", height: "28px", padding: "0",
    border: "0", borderRadius: "var(--dsw-radius-sm)", backgroundColor: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer",
  },
  ".cm-find-button:hover": { backgroundColor: "var(--dsw-alias-interactive-bg-hover)" },
  ".cm-find-button:focus-visible": { outline: "2px solid var(--dsw-alias-label-primary)", outlineOffset: "-2px" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--dsw-alias-state-warn-label) 22%, transparent)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--dsw-alias-state-warn-label) 48%, transparent)" },
});

export const findPanel = [search({ top: true, createPanel: createFindPanel }), findTheme];
