import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { MenuSurface, focusWithoutRing } from "../../../../../web/src/ui/shared/primitives.ts";
import { localize as t } from "../../../../../web/src/ui/locale/preference.ts";
import { FileTree } from "./FileTree.tsx";
import type { WorkspaceFileListing } from "../contract/workspace-files.ts";
import css from "../../../../../web/src/ui/workbench/WorkspacePanel.module.css";

/** Gap below the segment, the viewport margin kept clear, and the menu's height cap. */
const GAP = 4;
const MARGIN = 8;
const MAX_HEIGHT = 360;

interface Segment { name: string; path: string; title: string }

/** Ancestor directories of `file` that sit below `directory`, so the open file is visible in the menu. */
function expandedFor(directory: string, file: string | undefined): Set<string> {
  const parts = file?.split("/").slice(0, -1) ?? [];
  const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  return new Set(ancestors.filter(item => directory === "" || item.startsWith(`${directory}/`)));
}

/**
 * One directory's contents, portalled above the dock: the right sidebar slides
 * with a transform, which would otherwise become the fixed containing block.
 */
function DirectoryMenu({ anchor, segment, sessionId, levels, selected, onOpen, onDismiss }: {
  anchor: HTMLElement; segment: Segment; sessionId: string; levels: Map<string, WorkspaceFileListing>;
  selected: string | undefined; onOpen(path: string): void; onDismiss(): void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(() => expandedFor(segment.path, selected));
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const menu = self.current!;
    const rect = anchor.getBoundingClientRect();
    const top = rect.bottom + GAP;
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - menu.offsetWidth - MARGIN));
    setPosition({ top, left, maxHeight: Math.min(MAX_HEIGHT, Math.max(160, window.innerHeight - top - MARGIN)) });
    focusWithoutRing(menu);
  }, [anchor]);
  useEffect(() => {
    // The segment toggles its own menu; any other press outside dismisses it.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (self.current?.contains(event.target) || anchor.contains(event.target))) return;
      onDismiss();
    };
    // Capture phase, like the dock's tab menu: Escape closes this menu before any pane-level shortcut sees it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      event.preventDefault(); event.stopPropagation();
      const restore = self.current?.contains(document.activeElement) || document.activeElement === document.body || document.activeElement === anchor;
      onDismiss();
      if (restore) focusWithoutRing(anchor);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onDismiss);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onDismiss);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onDismiss]);
  const toggle = (directory: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(directory)) next.delete(directory); else next.add(directory);
    return next;
  });
  const label = t(`${segment.name} 中的文件`, `Files in ${segment.name}`);
  // The surface paints its material with an absolutely positioned layer, so it must not scroll itself:
  // an inner scroller keeps the background under every row.
  const { maxHeight, ...place } = position ?? { visibility: "hidden", top: 0, left: 0 };
  return createPortal(
    <MenuSurface ref={self} role="dialog" aria-label={label} tabIndex={-1} className={css.crumbMenu} style={place}
      onKeyDown={event => {
        if (event.target === self.current && event.key === "ArrowDown") {
          event.preventDefault();
          self.current.querySelector<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])')?.focus();
        }
      }}>
      <div className={css.crumbMenuScroll} style={{ maxHeight }}>
        <FileTree root={segment.path} label={label} sessionId={sessionId} levels={levels} revision={0} compact
          expanded={expanded} selected={selected} toggle={toggle} open={path => { onDismiss(); onOpen(path); }} />
      </div>
    </MenuSurface>,
    document.body,
  );
}

/** Workspace-relative path as clickable segments; each directory opens a menu of its contents. */
export function FileBreadcrumb({ sessionId, cwd, path, levels, onOpen }: {
  sessionId: string; cwd: string; path: string | undefined; levels: Map<string, WorkspaceFileListing>; onOpen(path: string): void;
}) {
  const [opened, setMenu] = useState<{ segment: Segment; anchor: HTMLElement; target: string } | null>(null);
  // A different file or workspace leaves no stale menu anchored to a removed segment.
  const target = `${cwd}\0${path ?? ""}`;
  const menu = opened?.target === target ? opened : null;
  const parts = path?.split("/") ?? [];
  const file = parts.length ? parts.at(-1) : undefined;
  const segments: Segment[] = [
    { name: cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd, path: "", title: cwd },
    ...parts.slice(0, -1).map((name, index) => {
      const value = parts.slice(0, index + 1).join("/");
      return { name, path: value, title: value };
    }),
  ];
  const dismiss = useRef(() => setMenu(null)).current;
  return <nav className={css.crumbs} aria-label={t("文件路径", "File path")}>
    <ol>
      {segments.map((segment, index) => <li key={segment.path}>
        {index > 0 && <span className={css.crumbSeparator} aria-hidden="true">/</span>}
        <button type="button" className={css.crumb} title={segment.title} aria-haspopup="dialog" aria-expanded={menu?.segment.path === segment.path}
          onClick={event => {
            const anchor = event.currentTarget;
            setMenu(current => current?.target === target && current.segment.path === segment.path ? null : { segment, anchor, target });
          }}>{segment.name}</button>
      </li>)}
      {file && <li className={css.crumbFile}>
        <span className={css.crumbSeparator} aria-hidden="true">/</span>
        <span className={css.crumbCurrent} title={path} aria-current="page">{file}</span>
      </li>}
    </ol>
    {menu && <DirectoryMenu key={menu.segment.path} anchor={menu.anchor} segment={menu.segment} sessionId={sessionId} levels={levels}
      selected={path} onOpen={onOpen} onDismiss={dismiss} />}
  </nav>;
}
