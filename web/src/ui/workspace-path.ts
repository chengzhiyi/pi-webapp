export function workspaceTitleOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

/** Unify local link identities; outside paths stay outside for the file API to reject. */
export function workspacePreviewPath(cwd: string, path: string): string {
  const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  let target = path.replaceAll("\\", "/");
  if (/^(?:\/|[a-z]:\/)/i.test(target)) {
    const windows = /^[a-z]:\//i.test(root);
    const prefix = `${root}/`;
    if (!(windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix))) return path;
    target = target.slice(prefix.length);
  }
  const parts: string[] = [];
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return path; parts.pop(); }
    else parts.push(part);
  }
  return parts.join("/") || path;
}
