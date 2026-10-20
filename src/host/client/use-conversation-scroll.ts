import { useCallback, useLayoutEffect, useRef, useState, type WheelEvent } from "react";

/** Follow new output until the reader scrolls up; only an explicit return resumes it. */
export function useConversationScroll(sessionId: string | undefined, active: boolean, pendingId: string | undefined) {
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);

  const follow = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    // Record programmatic moves so their scroll events cannot look like user input.
    lastTop.current = element.scrollTop;
    setShowLatest(false);
  }, []);

  const returnToLatest = useCallback(() => {
    following.current = true;
    follow();
  }, [follow]);

  const onScroll = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
    if (element.scrollTop < lastTop.current - 1) following.current = false;
    else if (gap <= 24) following.current = true;
    lastTop.current = element.scrollTop;
    setShowLatest(!following.current && gap > 1);
  }, []);

  const onWheel = useCallback((event: WheelEvent) => {
    // Pause before the browser scrolls, including when a chunk arrives in the same frame.
    if (event.deltaY < 0) following.current = false;
  }, []);

  useLayoutEffect(() => {
    // Opening a chat expresses intent to see the newest output.
    following.current = true;
    setShowLatest(false);
    if (!active) return;
    follow();
    const observer = new ResizeObserver(() => {
      const element = scroll.current;
      if (!element) return;
      element.style.setProperty("--piw-composer-height", `${composer.current?.getBoundingClientRect().height ?? 152}px`);
      if (following.current) follow();
      else setShowLatest(element.scrollHeight - element.clientHeight - element.scrollTop > 1);
    });
    for (const element of [scroll.current, content.current, composer.current]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sessionId, active, follow]);

  useLayoutEffect(() => {
    // Confirmation removes the optimistic echo; it must not interrupt reading.
    if (active && pendingId) returnToLatest();
  }, [active, pendingId, returnToLatest]);

  // Content updates can arrive before ResizeObserver; commit the scroll before paint.
  useLayoutEffect(() => {
    if (active && following.current) follow();
  });

  return { scroll, content, composer, onScroll, onWheel, showLatest: active && showLatest, returnToLatest };
}
