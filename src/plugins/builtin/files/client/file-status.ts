import type { WorkspaceFileState, WorkspaceFileStatus } from "../contract/workspace-files.ts";

/** What a tree row shows: a colour for the name and, for changes, a dot. Folders take their strongest child change. */
export type RowStatus = Exclude<WorkspaceFileState, "deleted">;

const rank: Record<RowStatus, number> = { ignored: 0, untracked: 1, added: 2, modified: 3, conflict: 4 };

export interface StatusIndex { of(path: string): RowStatus | undefined }

export const emptyStatus: StatusIndex = { of: () => undefined };

export function statusIndex(status: WorkspaceFileStatus): StatusIndex {
  const exact = new Map<string, RowStatus>();
  const covering: [string, RowStatus][] = [];
  const folders = new Map<string, RowStatus>();
  const raise = (path: string, state: RowStatus) => {
    const current = folders.get(path);
    if (current === undefined || rank[state] > rank[current]) folders.set(path, state);
  };
  for (const { path, state } of status.entries) {
    // A deleted file has no row; its folders still show that something changed inside.
    const shown: RowStatus = state === "deleted" ? "modified" : state;
    const directory = path.endsWith("/");
    const clean = directory ? path.slice(0, -1) : path;
    if (directory) covering.push([clean, shown]);
    else if (state !== "deleted") exact.set(clean, shown);
    if (shown === "ignored") continue;
    const parts = clean.split("/");
    for (let index = 1; index < parts.length; index++) raise(parts.slice(0, index).join("/"), shown);
  }
  return {
    of(path) {
      const hit = exact.get(path);
      if (hit) return hit;
      for (const [prefix, state] of covering) if (path === prefix || path.startsWith(`${prefix}/`)) return state;
      return folders.get(path);
    },
  };
}

export const statusLabel = (state: RowStatus, t: (zh: string, en: string) => string): string => ({
  modified: t("已修改", "Modified"), added: t("已添加", "Added"), untracked: t("未跟踪", "Untracked"),
  conflict: t("有冲突", "Conflict"), ignored: t("已忽略", "Ignored"),
})[state];
