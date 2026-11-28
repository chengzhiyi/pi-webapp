let cached: string | null | undefined;
let localGrant: string | null = null;
const grantKey = "pi-web-local-files";

export function accessToken(): string | null {
  if (cached !== undefined) return cached;
  const hash = location.hash.slice(1);
  const local = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(hash);
  const token = local?.[1] ?? hash;
  localGrant = local?.[2] ?? null;
  try {
    cached = token || sessionStorage.getItem("pi-web-token");
    if (hash) {
      sessionStorage.setItem("pi-web-token", token);
      if (localGrant) sessionStorage.setItem(grantKey, localGrant);
      else sessionStorage.removeItem(grantKey);
    } else if (cached) localGrant = sessionStorage.getItem(grantKey);
  } catch { cached = token || null; }
  if (hash) history.replaceState(null, "", location.pathname);
  return cached;
}

export function localFileGrant(): string | null {
  accessToken();
  return localGrant;
}
