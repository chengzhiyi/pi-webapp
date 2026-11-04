/**
 * CodeMirror 6 editor for workspace files. Loaded on demand (dynamic import), so the
 * editor and its grammars never enter the startup bundle; each language loads on first use.
 */
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Token colours come from the same `--shiki-*` sheet as read-only code blocks, so light/dark follow the app theme. */
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier, tags.self, tags.tagName], color: "var(--shiki-token-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.character, tags.inserted], color: "var(--shiki-token-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta], color: "var(--shiki-token-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.constant(tags.name), tags.standard(tags.name), tags.typeName, tags.className, tags.namespace, tags.unit], color: "var(--shiki-token-constant)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName, tags.labelName], color: "var(--shiki-token-function)" },
  { tag: [tags.attributeName, tags.local(tags.variableName), tags.special(tags.variableName)], color: "var(--shiki-token-parameter)" },
  { tag: [tags.punctuation, tags.bracket, tags.operator, tags.separator, tags.angleBracket], color: "var(--shiki-token-punctuation)" },
  { tag: [tags.link, tags.url], color: "var(--shiki-token-link)", textDecoration: "underline" },
  { tag: tags.heading, color: "var(--shiki-token-keyword)", fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.invalid, tags.deleted], color: "var(--dsw-alias-state-error-primary)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--shiki-foreground)", backgroundColor: "var(--shiki-background)", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--ds-font-family-code)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--dsw-alias-label-primary)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--dsw-alias-label-primary)" },
  ".cm-gutters": { backgroundColor: "var(--shiki-background)", color: "var(--dsw-alias-label-tertiary)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "3ch" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--dsw-alias-label-secondary)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--dsw-static-blue-500, #3b82f6) 22%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--dsw-alias-state-warn-label) 18%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)", outline: "none" },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "var(--dsw-alias-label-tertiary)" },
  ".cm-panels": { backgroundColor: "var(--dsw-alias-bg-layer-1, var(--shiki-background))", color: "var(--dsw-alias-label-primary)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "0.5px solid var(--dsw-alias-border-l3)" },
  ".cm-tooltip": { border: "0.5px solid var(--dsw-alias-border-l2)", backgroundColor: "var(--dsw-alias-bg-layer-1, var(--shiki-background))" },
});

export interface CodeEditorHandle {
  /** Replace the whole document without reporting it as a user edit. */
  setText(text: string): void;
  reveal(line: number): void;
  focus(): void;
  destroy(): void;
}

export function createCodeEditor(parent: HTMLElement, options: {
  text: string; filename: string; label: string; onChange(text: string): void; onSave(): void;
}): CodeEditorHandle {
  const language = new Compartment();
  // The page's CSP admits only nonce-tagged <style> elements; the terminal reads the same meta tag.
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="pi-style-nonce"]')?.content;
  let external = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        basicSetup,
        // Tab indents; Escape then Tab moves focus on, so the editor never traps the keyboard.
        keymap.of([indentWithTab]),
        Prec.highest(keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { options.onSave(); return true; } }])),
        syntaxHighlighting(highlight),
        theme,
        language.of([]),
        ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
        EditorView.contentAttributes.of({ "aria-label": options.label }),
        EditorView.updateListener.of(update => { if (update.docChanged && !external) options.onChange(update.state.doc.toString()); }),
      ],
    }),
  });
  let destroyed = false;
  const description = LanguageDescription.matchFilename(languages, options.filename);
  void description?.load().then(support => { if (!destroyed) view.dispatch({ effects: language.reconfigure(support) }); }).catch(() => { /* Plain text still edits. */ });
  return {
    setText(text) {
      if (text === view.state.doc.toString()) return;
      external = true;
      try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); } finally { external = false; }
    },
    reveal(line) {
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
      view.dispatch({ selection: { anchor: target.from, head: target.to }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
    },
    focus: () => view.focus(),
    destroy() { destroyed = true; view.destroy(); },
  };
}
