/** Test-only instrumentation of actual browser primitives, installed before application code.
 * Reports do not retain DOM/windows/ports. It neither synthesizes dispose nor clears resources.
 */
export function installLifecycleProbe() {
  const intervals = new Set<number>();
  const originalInterval = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
  window.setInterval = ((...args: Parameters<typeof window.setInterval>) => { const id = originalInterval(...args); intervals.add(id); return id; }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => { if (id !== undefined) intervals.delete(id); clear(id); }) as typeof window.clearInterval;
  const watched = new Set(["message", "compositionstart", "compositionend", "pointerdown", "pointerup", "pointercancel", "pagehide"]);
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => {
    if (watched.has(type)) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); }
    return add(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: any) => { listeners.get(type)?.delete(listener); return remove(type, listener, options); }) as typeof window.removeEventListener;
  const originalClose = MessagePort.prototype.close;
  MessagePort.prototype.close = function () {
    if (window !== window.top) console.info("ORI40_LIFECYCLE " + JSON.stringify({ url: location.href, intervals: intervals.size, windowListeners: [...listeners.values()].reduce((n, set) => n + set.size, 0) }));
    return originalClose.call(this);
  };
  if (window === window.top) {
    const channels: Array<{ port: WeakRef<MessagePort>; closed: boolean; started: boolean }> = [], frames: Array<WeakRef<HTMLIFrameElement>> = [];
    const Original = MessageChannel;
    window.MessageChannel = class extends Original {
      constructor() { super(); channels.push({ port: new WeakRef(this.port1), closed: false, started: false }); }
    };
    const start = MessagePort.prototype.start;
    MessagePort.prototype.start = function () { for (const entry of channels) if (entry.port.deref() === this) entry.started = true; return start.call(this); };
    MessagePort.prototype.close = function () { for (const entry of channels) if (entry.port.deref() === this) entry.closed = true; return originalClose.call(this); };
    (window as any).__ori40 = {
      capture() { frames.push(...Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[title^="Excalidraw "]'), frame => new WeakRef(frame))); },
      sample() { return { channels: channels.length, openPorts: channels.filter(entry => entry.started && !entry.closed && entry.port.deref()).length, detachedFramesRetained: frames.flatMap(ref => { const frame = ref.deref(); return frame && !frame.isConnected ? [{ title: frame.title, src: frame.src }] : []; }) }; },
    };
  }
}
