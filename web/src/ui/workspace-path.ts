export function workspaceTitleOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}
