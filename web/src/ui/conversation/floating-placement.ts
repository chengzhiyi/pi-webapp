/**
 * Placement geometry for the floating composer. A position is stored relative
 * to one of six anchors (top/bottom x left/centre/right) so a resize keeps the
 * composer where the user put it; every resolved box is clamped inside bounds.
 */
export type FloatingAnchor = "tl" | "tc" | "tr" | "bl" | "bc" | "br";
export interface FloatingPlacement { anchor: FloatingAnchor; dx: number; dy: number }
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }

export const FLOATING_ANCHORS: readonly FloatingAnchor[] = ["tl", "tc", "tr", "bl", "bc", "br"];
/** Side and top clearance inside the bounds. */
export const FLOATING_MARGIN = 12;
/** Bottom clearance at a bottom anchor. */
export const FLOATING_BOTTOM = 16;
/** Release distance from an anchor that snaps onto it. */
export const FLOATING_SNAP = 48;
/** Bounds narrower than this dock full width at the top or bottom only. */
export const FLOATING_NARROW = 480;
export const DEFAULT_PLACEMENT: FloatingPlacement = { anchor: "bc", dx: 0, dy: 0 };

export const isTopAnchor = (anchor: FloatingAnchor) => anchor[0] === "t";

/** Bar width for the given bounds width. */
export function floatingWidth(boundsWidth: number): number {
  if (boundsWidth < FLOATING_NARROW) return Math.max(0, boundsWidth - FLOATING_MARGIN * 2);
  return Math.round(Math.min(640, Math.max(320, boundsWidth * 0.46)));
}

/** Top-left of a box of `size` sitting exactly on `anchor`. */
export function anchorPoint(anchor: FloatingAnchor, bounds: Size, size: Size): Point {
  const column = anchor[1];
  const x = column === "l" ? FLOATING_MARGIN : column === "r" ? bounds.width - size.width - FLOATING_MARGIN : (bounds.width - size.width) / 2;
  const y = isTopAnchor(anchor) ? FLOATING_MARGIN : bounds.height - size.height - FLOATING_BOTTOM;
  return { x, y };
}

/** Keep a box inside the bounds margins; an oversized box centres on the axis it overflows. */
export function clampPoint(point: Point, bounds: Size, size: Size): Point {
  const axis = (value: number, span: number, extent: number, end: number) => {
    const max = span - extent - end;
    return max < FLOATING_MARGIN ? (span - extent) / 2 : Math.min(max, Math.max(FLOATING_MARGIN, value));
  };
  return { x: Math.round(axis(point.x, bounds.width, size.width, FLOATING_MARGIN)), y: Math.round(axis(point.y, bounds.height, size.height, FLOATING_MARGIN)) };
}

/** Resolve a stored placement into a clamped top-left. */
export function resolvePlacement(placement: FloatingPlacement, bounds: Size, size: Size): Point {
  const base = anchorPoint(placement.anchor, bounds, size);
  return clampPoint({ x: base.x + placement.dx, y: base.y + placement.dy }, bounds, size);
}

/** Convert a dropped top-left into a placement: snap near an anchor, otherwise keep the offset from the nearest one. */
export function settlePlacement(point: Point, bounds: Size, size: Size, narrow = bounds.width < FLOATING_NARROW): FloatingPlacement {
  const clamped = clampPoint(point, bounds, size);
  if (narrow) return { anchor: clamped.y + size.height / 2 < bounds.height / 2 ? "tc" : "bc", dx: 0, dy: 0 };
  let best: FloatingAnchor = "bc";
  let distance = Infinity;
  for (const anchor of FLOATING_ANCHORS) {
    const target = anchorPoint(anchor, bounds, size);
    const next = Math.hypot(target.x - clamped.x, target.y - clamped.y);
    if (next < distance) { distance = next; best = anchor; }
  }
  if (distance <= FLOATING_SNAP) return { anchor: best, dx: 0, dy: 0 };
  const target = anchorPoint(best, bounds, size);
  return { anchor: best, dx: Math.round(clamped.x - target.x), dy: Math.round(clamped.y - target.y) };
}

/** Keyboard move: shift the resolved box, keep the same anchor, clamp. */
export function nudgePlacement(placement: FloatingPlacement, delta: Point, bounds: Size, size: Size): FloatingPlacement {
  const current = resolvePlacement(placement, bounds, size);
  const next = clampPoint({ x: current.x + delta.x, y: current.y + delta.y }, bounds, size);
  const base = anchorPoint(placement.anchor, bounds, size);
  return { anchor: placement.anchor, dx: Math.round(next.x - base.x), dy: Math.round(next.y - base.y) };
}

export interface FloatingPreference { placement: FloatingPlacement; collapsed: boolean }

/** Parse the stored preference, falling back field by field. */
export function parseFloatingPreference(raw: string | null): FloatingPreference {
  const fallback: FloatingPreference = { placement: DEFAULT_PLACEMENT, collapsed: false };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as { anchor?: unknown; dx?: unknown; dy?: unknown; collapsed?: unknown };
    const anchor = FLOATING_ANCHORS.includes(value.anchor as FloatingAnchor) ? value.anchor as FloatingAnchor : null;
    const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
    return {
      placement: anchor ? { anchor, dx: finite(value.dx), dy: finite(value.dy) } : DEFAULT_PLACEMENT,
      collapsed: value.collapsed === true,
    };
  } catch { return fallback; }
}

export function serializeFloatingPreference(value: FloatingPreference): string {
  return JSON.stringify({ ...value.placement, collapsed: value.collapsed });
}
