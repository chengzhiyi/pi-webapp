import type { Bounds } from "./desktop-api.ts";

const overlays = '[role="dialog"][aria-modal="true"], dialog[open], [role="menu"]';
const hidden = '[hidden], [aria-hidden="true"], [inert]';

function viewportBounds(anchor: HTMLElement): Bounds | null {
  if (document.visibilityState === "hidden" || !anchor.isConnected || anchor.closest(hidden) ||
    getComputedStyle(anchor).visibility !== "visible") return null;
  // The native view is above renderer DOM. Keep it out of the way of modal
  // layers, including the narrow layout's navigation drawer.
  for (const layer of Array.from(document.querySelectorAll(overlays))) {
    if (!layer.contains(anchor) && !layer.closest(hidden) && layer.getClientRects().length &&
      getComputedStyle(layer).visibility === "visible") return null;
  }

  const rect = anchor.getBoundingClientRect();
  const visual = window.visualViewport;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  const x = Math.ceil(Math.max(rect.left, left));
  const y = Math.ceil(Math.max(rect.top, top));
  const right = Math.floor(Math.min(rect.right, left + (visual?.width ?? document.documentElement.clientWidth)));
  const bottom = Math.floor(Math.min(rect.bottom, top + (visual?.height ?? document.documentElement.clientHeight)));
  if (right <= x || bottom <= y) return null;

  // Detect an inactive or obscured dock, without treating its edge resize
  // handles and rounded corners as a full-surface overlay.
  if (!anchor.contains(document.elementFromPoint((x + right) / 2, (y + bottom) / 2))) return null;
  // getBoundingClientRect already uses CSS pixels; do not apply DPR or zoom.
  return { x, y, width: right - x, height: bottom - y };
}

export function watchPreviewLayout(anchor: HTMLElement, send: (bounds: Bounds | null) => void) {
  let frame = 0;
  let previous: Bounds | null | undefined;
  let pageHidden = false;
  const publish = (next: Bounds | null) => {
    if (previous === next || (previous && next && previous.x === next.x && previous.y === next.y &&
      previous.width === next.width && previous.height === next.height)) return;
    previous = next;
    send(next);
  };
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = anchor; node; node = node.parentElement) ancestors.push(node);
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  function measure() {
    frame = 0;
    publish(pageHidden ? null : viewportBounds(anchor));
    // The dock can slide without changing size; follow its CSS transitions.
    if (!pageHidden && document.visibilityState !== "hidden" && ancestors.some(node =>
      node.getAnimations().some(animation => animation instanceof CSSTransition && animation.playState === "running"))) schedule();
  }
  const visibility = () => { if (document.visibilityState === "hidden") publish(null); else schedule(); };
  const pageHide = () => { pageHidden = true; publish(null); };
  const pageShow = () => { pageHidden = false; schedule(); };
  const resize = new ResizeObserver(schedule);
  for (const node of ancestors) resize.observe(node);
  const intersection = new IntersectionObserver(schedule);
  intersection.observe(anchor);
  const mutations = new MutationObserver(schedule);
  mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["role", "aria-modal", "aria-hidden", "hidden", "inert", "open", "style", "class"] });
  const visual = window.visualViewport;
  const events = new AbortController();
  const options = { signal: events.signal };
  window.addEventListener("resize", schedule, options);
  window.addEventListener("scroll", schedule, { ...options, capture: true, passive: true });
  window.addEventListener("pagehide", pageHide, options);
  window.addEventListener("pageshow", pageShow, options);
  document.addEventListener("visibilitychange", visibility, options);
  document.addEventListener("transitionrun", schedule, options);
  visual?.addEventListener("resize", schedule, options);
  visual?.addEventListener("scroll", schedule, options);
  const watchZoom = () => {
    // A zoom change can alter native bounds even if CSS bounds are unchanged.
    previous = undefined;
    schedule();
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", watchZoom, { ...options, once: true });
  };
  watchZoom();
  return () => {
    events.abort();
    cancelAnimationFrame(frame);
    resize.disconnect();
    intersection.disconnect();
    mutations.disconnect();
    publish(null);
  };
}
