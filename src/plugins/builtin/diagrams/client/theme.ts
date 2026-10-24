import { useSyncExternalStore } from "react";

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
  return () => observer.disconnect();
}
const snapshot = () => document.body.hasAttribute("data-ds-dark-theme") ? "dark" as const : "light" as const;
/** UI appearance only: never persist a theme change as a drawing edit. */
export function useDiagramTheme() { return useSyncExternalStore(subscribe, snapshot); }
