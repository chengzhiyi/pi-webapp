/** Paths are relative to the session workspace, with forward-slash separators. */
export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
}

export interface WorkspaceFileListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

export type WorkspaceFilePreview = { path: string; size: number } & (
  /** `version` is the SHA-256 of the bytes read; a save must name the version it was edited from. */
  | { kind: "text"; text: string; version: string }
  | { kind: "image"; mimeType: string; data: string }
  | { kind: "unsupported" }
  | { kind: "too-large"; limit: number; unit: "bytes" | "lines" }
);

export interface WorkspaceFileWrite { path: string; size: number; version: string }

/** Workspace-relative Git state. Paths ending in "/" cover a whole untracked or ignored directory. */
export type WorkspaceFileState = "modified" | "added" | "deleted" | "untracked" | "conflict" | "ignored";
export interface WorkspaceFileStatus {
  kind: "repository" | "not-repository" | "unavailable";
  entries: { path: string; state: WorkspaceFileState }[];
  truncated: boolean;
}

export type WorkspaceFileSearch =
  | { kind: "name"; results: { path: string }[]; truncated: boolean }
  | { kind: "content"; results: { path: string; line: number; text: string }[]; truncated: boolean };
