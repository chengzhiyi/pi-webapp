let cached: string | null | undefined;
export function accessToken(): string | null {
  if (cached !== undefined) return cached;
  const hash = location.hash.slice(1);
  try {
    cached = hash || sessionStorage.getItem("pi-web-token");
    if (hash) sessionStorage.setItem("pi-web-token", hash);
  } catch { cached = hash || null; }
  if (hash) history.replaceState(null, "", location.pathname);
  return cached;
}
