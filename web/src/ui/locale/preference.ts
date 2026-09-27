import { useSyncExternalStore } from "react";

export type Locale = "zh" | "en";

const key = "pi-web-locale";
const listeners = new Set<() => void>();

function browserLocale(): Locale {
  if (typeof navigator === "undefined") return "zh";
  return (navigator.languages?.[0] ?? navigator.language ?? "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function readPreference(): Locale {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "zh" || stored === "en") return stored;
  } catch { /* Keep a usable browser-derived locale when storage is unavailable. */ }
  return browserLocale();
}

let locale = readPreference();

function publish(next: Locale) {
  if (locale === next) return;
  locale = next;
  if (typeof document !== "undefined") document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  listeners.forEach((listener) => listener());
}

export function installLocalePreference() {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  window.addEventListener("storage", (event) => {
    if (event.key === key) publish(readPreference());
  });
}

export function setLocalePreference(next: Locale) {
  try { localStorage.setItem(key, next); } catch { /* Keep the in-memory choice. */ }
  publish(next);
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => locale,
  );
}

export function textFor(locale: Locale, zh: string, en: string): string {
  return locale === "zh" ? zh : en;
}

export function localize(zh: string, en: string): string {
  return textFor(locale, zh, en);
}
