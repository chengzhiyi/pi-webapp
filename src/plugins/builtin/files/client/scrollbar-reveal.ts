import { useEffect, type RefObject } from "react";

const timers = new WeakMap<Element, number>();
/** How long a scrollbar stays visible after the last scroll event. */
const LINGER_MS = 900;

/**
 * Mark whichever element under `root` is scrolling with `data-scrolling`, briefly.
 * Scroll events do not bubble, but they do pass through ancestors in the capture phase,
 * so one listener covers the tree, search results, the editor and the breadcrumb menu.
 */
export function revealScrollbarsWhileScrolling(root: HTMLElement): () => void {
  const onScroll = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    target.setAttribute("data-scrolling", "");
    window.clearTimeout(timers.get(target));
    timers.set(target, window.setTimeout(() => target.removeAttribute("data-scrolling"), LINGER_MS));
  };
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}

export function useScrollbarReveal(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = root.current;
    return element ? revealScrollbarsWhileScrolling(element) : undefined;
  }, [root]);
}
