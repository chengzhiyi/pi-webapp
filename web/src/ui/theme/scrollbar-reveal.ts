const timers = new WeakMap<Element, number>();
/** How long a scrollbar stays visible after the last scroll event. */
const LINGER_MS = 900;

/**
 * Mark whichever element is scrolling with `data-scrolling`, briefly; scrollbar.css paints
 * the thumb only on marked elements. Scroll events do not bubble, but they pass through
 * the document in the capture phase, so one listener covers every scroller, portals included.
 */
export function installScrollbarReveal(): void {
  document.addEventListener("scroll", event => {
    const target = event.target === document ? document.documentElement : event.target;
    if (!(target instanceof Element)) return;
    target.setAttribute("data-scrolling", "");
    window.clearTimeout(timers.get(target));
    timers.set(target, window.setTimeout(() => target.removeAttribute("data-scrolling"), LINGER_MS));
  }, { capture: true, passive: true });
}
