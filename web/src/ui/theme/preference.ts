import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";

const key = "pi-web-theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");
let preference: ThemePreference = readPreference();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch { /* Storage may be unavailable; system is the safe default. */ }
  return "system";
}

function applyTheme() {
  document.body.toggleAttribute("data-ds-dark-theme", preference === "dark" || (preference === "system" && media.matches));
}

export function installThemePreference() {
  applyTheme();
  media.addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.key !== key) return;
    preference = readPreference();
    applyTheme();
    listeners.forEach((listener) => listener());
  });
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try { localStorage.setItem(key, next); } catch { /* Keep the in-memory choice. */ }
  applyTheme();
  listeners.forEach((listener) => listener());
}

export function useThemePreference() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => preference,
  );
}
