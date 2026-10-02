import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEventHandler, type KeyboardEventHandler, type CSSProperties } from 'react';
import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $addUpdateTag, CLEAR_HISTORY_COMMAND, SKIP_DOM_SELECTION_TAG, createEditor, BLUR_COMMAND, SELECTION_CHANGE_COMMAND, RootNode, COMMAND_PRIORITY_CRITICAL } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';
import { ComposerContentEditable } from '../dsh/composer/ComposerContentEditable.tsx';
import { refreshClaimDecoration, registerClaimDecoration } from '../dsh/composer/claim-decor.ts';
import css from './InputBar.module.css';

export interface ComposerEditorHandle { focus(): void }
interface Props {
  value: string;
  onChange(value: string): void;
  claimToken: string | null;
  hint: string | null;
  placeholder: string;
  ariaLabel: string;
  editable: boolean;
  menuOpen: boolean;
  activeOption?: string;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste: ClipboardEventHandler<HTMLDivElement>;
}

/** Pi's draft/action adapter over DSH's resident editable and claim decoration. */
export const PiComposerEditor = forwardRef<ComposerEditorHandle, Props>(function PiComposerEditor(props, ref) {
  const live = useRef(props);
  live.current = props;
  const [editor] = useState(() => createEditor({ namespace: 'pi-composer', onError: error => { throw error; } }));
  const [composing, setComposing] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => editor.focus() }), [editor]);
  useLayoutEffect(() => {
    // DSH runtime's selection guard: restyling must not steal focus back
    // from a menu, model picker, or another control.
    const preserveExternalSelection = (): false => {
      const root = editor.getRootElement();
      if (root && !root.contains(root.ownerDocument.activeElement)) $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      return false;
    };
    const cleanups = [
      editor.registerCommand(BLUR_COMMAND, () => { editor.update(preserveExternalSelection, { discrete: true }); return false; }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, preserveExternalSelection, COMMAND_PRIORITY_CRITICAL),
      editor.registerNodeTransform(RootNode, preserveExternalSelection),
      registerPlainText(editor), registerHistory(editor, createEmptyHistoryState(), 1000),
      registerClaimDecoration(editor, () => live.current.claimToken),
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        const text = editorState.read(() => $getRoot().getTextContent());
        if (text !== live.current.value) live.current.onChange(text);
      })];
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [editor]);
  useLayoutEffect(() => {
    const current = editor.getEditorState().read(() => $getRoot().getTextContent());
    if (current === props.value && !editor.getEditorState().isEmpty()) return;
    editor.update(() => {
      const root = $getRoot();
      const focused = editor.getRootElement()?.contains(document.activeElement);
      if (!focused) $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      const paragraph = $createParagraphNode();
      for (const [index, line] of props.value.split('\n').entries()) {
        if (index) paragraph.append($createLineBreakNode());
        if (line) paragraph.append($createTextNode(line));
      }
      root.clear().append(paragraph);
      if (focused) paragraph.selectEnd();
    }, { discrete: true });
    if (!props.value) editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }, [editor, props.value]);
  useLayoutEffect(() => { refreshClaimDecoration(editor); }, [editor, props.claimToken]);

  return <div className={css.scroll} data-input-scroll>
    <div className={css.grow}>
      <ComposerContentEditable editor={editor} editable={props.editable} className={css.input}
        aria-label={props.ariaLabel} aria-disabled={!props.editable || undefined} aria-haspopup="listbox"
        aria-expanded={props.menuOpen} aria-activedescendant={props.activeOption}
        data-phase={props.claimToken ? 'claimed' : 'plain'} data-placeholder={props.placeholder}
        data-composer-composing={composing || undefined}
        style={props.hint === null ? undefined : { '--dsh-composer-hint': JSON.stringify(props.hint) } as CSSProperties}
        onKeyDownCapture={event => { props.onKeyDown(event); if (event.defaultPrevented) event.stopPropagation(); }}
        onPasteCapture={event => { props.onPaste(event); if (event.defaultPrevented) event.stopPropagation(); }}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
      {props.value === '' && <div aria-hidden className={css.placeholder} data-composer-placeholder>{props.placeholder}</div>}
    </div>
  </div>;
});
