/**
 * Floating shell for the composer while the conversation is hidden behind a
 * focused or fullscreen workspace panel. It owns only placement (anchor +
 * offset inside the panel body, persisted), collapse to an icon, the ⌘J/Ctrl+J
 * shortcut, focus return, and staying out of panel gestures. The composer form
 * and the status/reply surface arrive as children, so the draft stays owned by
 * the one composer instance.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PiLogo } from "../primitives/index.ts";
import {
  DEFAULT_PLACEMENT, FLOATING_BOTTOM, FLOATING_NARROW, anchorPoint, clampPoint, floatingWidth, isTopAnchor,
  nudgePlacement, parseFloatingPreference, resolvePlacement, serializeFloatingPreference, settlePlacement,
  type FloatingPlacement, type FloatingPreference, type Point, type Size,
} from "./floating-placement.ts";
import css from "./FloatingComposer.module.css";

export type FloatingIconState = "idle" | "running" | "unread" | "input" | "error" | "offline";
export interface FloatingComposerApi { collapse(): void; releaseFocus(): void }

const STORAGE_KEY = "pi.floatingComposer.v1";
const ICON = 40;
const BAR = 44;
/** Bottom docking distance that reserves room in the panel content. */
const INSET_REACH = 120;
/** Panel bodies shorter than this start with the icon and never give up content height. */
const SHORT_BODY = 400;

interface Bounds extends Size { left: number; top: number }

function readPreference(): FloatingPreference {
  try { return parseFloatingPreference(localStorage.getItem(STORAGE_KEY)); }
  catch { return { placement: DEFAULT_PLACEMENT, collapsed: false }; }
}

const isMac = () => /Mac|iPhone|iPad/u.test(navigator.platform);

/** The ⌘J (macOS) / Ctrl+J chord; Ctrl+J stays a line feed inside a terminal elsewhere. */
function isToggleChord(event: KeyboardEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || event.key.toLowerCase() !== "j") return false;
  const mac = isMac();
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return mac || !(event.target instanceof Element && event.target.closest(".xterm"));
}

export function FloatingComposer({ host, bounds: panel, status, iconState, iconLabel, labels, focusInput, onContentPointerDown, children }: {
  host: HTMLElement;
  /** The workspace panel; the composer lives inside its body below the tab strip. */
  bounds: HTMLElement | null;
  status: ReactNode;
  iconState: FloatingIconState;
  iconLabel: string;
  labels: { region: string; grip: string; snapHint: string };
  focusInput(): void;
  /** A pointer went down in the panel outside the composer. */
  onContentPointerDown?(): void;
  children: (api: FloatingComposerApi) => ReactNode;
}) {
  const [preference, setPreference] = useState(readPreference);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [height, setHeight] = useState(BAR);
  const [drag, setDrag] = useState<Point | null>(null);
  const [passthrough, setPassthrough] = useState(false);
  const root = useRef<HTMLElement>(null);
  const icon = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<"input" | "icon" | "return" | null>(null);
  const gesture = useRef<{ id: number; origin: Point; start: Point; moved: boolean; target: "grip" | "icon" } | null>(null);
  const suppressClick = useRef(false);
  const contentDown = useRef(onContentPointerDown);
  contentDown.current = onContentPointerDown;
  // Short bodies (landscape phones, tiny windows) start with the icon without touching the stored preference.
  const short = bounds !== null && bounds.height < SHORT_BODY;
  const [shortOpen, setShortOpen] = useState(false);
  useEffect(() => { if (!short) setShortOpen(false); }, [short]);
  const shortRef = useRef(short);
  shortRef.current = short;
  const collapsed = short ? !shortOpen : preference.collapsed;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, serializeFloatingPreference(preference)); } catch { /* Private mode keeps the in-memory preference. */ }
  }, [preference]);

  // Panel body rect relative to the overlay host; the tab strip stays uncovered.
  useLayoutEffect(() => {
    if (!panel) { setBounds(null); return; }
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const origin = host.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      const strip = panel.querySelector("[data-dockkit-strip]")?.getBoundingClientRect();
      const top = strip && strip.bottom > rect.top && strip.bottom < rect.bottom ? strip.bottom : rect.top;
      const next = { left: Math.round(rect.left - origin.left), top: Math.round(top - origin.top), width: Math.round(rect.width), height: Math.round(rect.bottom - top) };
      setBounds(previous => previous && previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    const schedule = () => { frame ??= requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(panel);
    observer.observe(host);
    window.addEventListener("resize", schedule);
    panel.addEventListener("transitionend", schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      panel.removeEventListener("transitionend", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [host, panel]);

  const hasBounds = bounds !== null;
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setHeight(Math.round(element.getBoundingClientRect().height) || (collapsed ? ICON : BAR));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed, hasBounds]);

  const narrow = (bounds?.width ?? 0) < FLOATING_NARROW;
  const width = collapsed ? ICON : floatingWidth(bounds?.width ?? 0);
  const size: Size = { width, height: collapsed ? ICON : Math.max(height, BAR) };
  const placement: FloatingPlacement = narrow
    ? collapsed ? { anchor: "br", dx: 0, dy: 0 } : { anchor: isTopAnchor(preference.placement.anchor) ? "tc" : "bc", dx: 0, dy: 0 }
    : preference.placement;
  const top = isTopAnchor(placement.anchor);
  const point = bounds ? drag ?? resolvePlacement(placement, bounds, size) : null;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  const setCollapsed = useCallback((value: boolean) => {
    if (shortRef.current) setShortOpen(!value);
    else setPreference(current => current.collapsed === value ? current : { ...current, collapsed: value });
  }, []);
  const releaseFocus = useCallback(() => {
    const target = returnFocus.current;
    if (target?.isConnected) target.focus();
    else if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) document.activeElement.blur();
  }, []);
  const collapse = useCallback(() => {
    pendingFocus.current = root.current?.contains(document.activeElement) ? "icon" : null;
    setCollapsed(true);
  }, [setCollapsed]);
  const expand = useCallback((focus: boolean) => {
    pendingFocus.current = focus ? "input" : null;
    setCollapsed(false);
  }, [setCollapsed]);

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    // One frame later: the editor has just remounted and registers its root in its own effects.
    const frame = requestAnimationFrame(() => {
      if (target === "input") focusInput();
      else if (target === "icon") icon.current?.focus();
      else releaseFocus();
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, focusInput, releaseFocus]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isToggleChord(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (collapsed) { expand(true); return; }
      if (root.current?.contains(document.activeElement)) { pendingFocus.current = "return"; setCollapsed(true); return; }
      focusInput();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [collapsed, expand, focusInput, setCollapsed]);

  // A gesture that starts in the panel passes under the composer untouched.
  useEffect(() => {
    if (!panel) return;
    let active: number | null = null;
    const down = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !panel.contains(event.target) || root.current?.contains(event.target)) return;
      active = event.pointerId;
      contentDown.current?.();
    };
    const move = (event: PointerEvent) => {
      if (active !== event.pointerId || event.buttons === 0) return;
      const rect = root.current?.getBoundingClientRect();
      if (rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) setPassthrough(true);
    };
    const end = (event: PointerEvent) => { if (active === event.pointerId) { active = null; setPassthrough(false); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, { capture: true, passive: true });
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
    };
  }, [panel]);

  // Docked at the bottom: a narrow, full-width composer is a footer, so tab content ends above it
  // (`inset`). A floating bar on a wide panel takes no height; scrollable panels (the editor) only
  // add room to scroll their end clear of it (`overlap`).
  const docked = !top && !short && bounds && point && bounds.height - (point.y + size.height) <= INSET_REACH ? size.height + FLOATING_BOTTOM : 0;
  const inset = narrow ? docked : 0;
  const overlap = narrow ? 0 : docked;
  useEffect(() => {
    if (!panel) return;
    const apply = (name: string, value: number) => { if (value) panel.style.setProperty(name, `${value}px`); else panel.style.removeProperty(name); };
    apply("--pi-floating-composer-inset", inset);
    apply("--pi-floating-composer-overlap", overlap);
    return () => { panel.style.removeProperty("--pi-floating-composer-inset"); panel.style.removeProperty("--pi-floating-composer-overlap"); };
  }, [panel, inset, overlap]);
  // While the bar is open it carries the session's requests (approvals); panels drop their own copy.
  useEffect(() => {
    if (!panel || collapsed) return;
    panel.setAttribute("data-floating-composer-open", "");
    return () => panel.removeAttribute("data-floating-composer-open");
  }, [panel, collapsed]);

  const startDrag = (event: React.PointerEvent<HTMLElement>, target: "grip" | "icon") => {
    if (event.button !== 0 || !point || gesture.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, origin: { x: event.clientX, y: event.clientY }, start: point, moved: false, target };
    if (target === "grip") event.preventDefault();
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    const area = boundsRef.current;
    if (!current || current.id !== event.pointerId || !area) return;
    const dx = event.clientX - current.origin.x, dy = event.clientY - current.origin.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;
    setDrag(clampPoint({ x: current.start.x + (narrow ? 0 : dx), y: current.start.y + dy }, area, sizeRef.current));
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    const area = boundsRef.current;
    if (current.moved && area && !cancelled) {
      const dropped = clampPoint({ x: current.start.x + (narrow ? 0 : event.clientX - current.origin.x), y: current.start.y + event.clientY - current.origin.y }, area, sizeRef.current);
      // The collapsed icon keeps the bar's anchor; moving it only changes where it sits.
      const settled = settlePlacement(dropped, area, sizeRef.current);
      setPreference(previous => ({ ...previous, placement: settled }));
    }
    suppressClick.current = current.moved;
    setDrag(null);
  };
  const reset = () => setPreference(current => ({ ...current, placement: DEFAULT_PLACEMENT }));
  const onGripKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const area = boundsRef.current;
    if (!area) return;
    if (event.key === "Home") { event.preventDefault(); reset(); return; }
    const step = event.shiftKey ? 64 : 16;
    const delta = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } }[event.key];
    if (!delta) return;
    event.preventDefault();
    if (narrow) { if (delta.y) setPreference(current => ({ ...current, placement: { anchor: delta.y < 0 ? "tc" : "bc", dx: 0, dy: 0 } })); return; }
    setPreference(current => ({ ...current, placement: nudgePlacement(current.placement, delta, area, sizeRef.current) }));
  };

  if (!bounds || !point || bounds.width <= 0 || bounds.height <= 0) return null;
  // While dragging near a snap position, outline where the composer will land.
  const settled = drag ? settlePlacement(drag, bounds, size) : null;
  const snapTarget = settled && settled.dx === 0 && settled.dy === 0 ? anchorPoint(settled.anchor, bounds, size) : null;
  const style: React.CSSProperties = drag
    ? { left: bounds.left + point.x, top: bounds.top + point.y, width }
    : top ? { left: bounds.left + point.x, top: bounds.top + point.y, width }
      : { left: bounds.left + point.x, bottom: `calc(100% - ${bounds.top + point.y + size.height}px)`, width };

  return createPortal(<>
    {snapTarget && <div className={css.ghost} aria-hidden="true" data-floating-snap-target
      style={{ left: bounds.left + snapTarget.x, top: bounds.top + snapTarget.y, width: size.width, height: size.height }} />}
    <section ref={root} className={css.root} style={style} data-floating-composer={collapsed ? "collapsed" : "expanded"}
      data-edge={top ? "top" : "bottom"} data-dragging={drag ? "" : undefined} data-passthrough={passthrough || undefined} data-narrow={narrow || undefined}
      aria-label={labels.region}
      onFocus={event => { if (!(event.relatedTarget instanceof HTMLElement) || !root.current?.contains(event.relatedTarget)) returnFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null; }}>
      {collapsed
        ? <button ref={icon} type="button" className={css.icon} data-state={iconState} aria-label={iconLabel} title={iconLabel} aria-expanded={false}
            onPointerDown={event => startDrag(event, "icon")} onPointerMove={moveDrag} onPointerUp={event => endDrag(event, false)} onPointerCancel={event => endDrag(event, true)}
            onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } expand(true); }}>
            <PiLogo size={18} />
            {iconState !== "idle" && iconState !== "offline" && <span className={css.badge} aria-hidden="true" />}
          </button>
        : <>
            {status && <div className={css.status} data-floating-status>{status}</div>}
            <div className={css.bar}>
              <button type="button" className={css.grip} aria-label={labels.grip} title={labels.snapHint}
                onPointerDown={event => startDrag(event, "grip")} onPointerMove={moveDrag} onPointerUp={event => endDrag(event, false)} onPointerCancel={event => endDrag(event, true)}
                onDoubleClick={reset} onKeyDown={onGripKey}>
                <svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">{[2, 7, 12].flatMap(y => [2, 6].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="currentColor" />))}</svg>
              </button>
              {children({ collapse, releaseFocus })}
            </div>
          </>}
    </section>
  </>, host);
}
