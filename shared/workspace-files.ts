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
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: string; data: string }
  | { kind: "unsupported" }
  | { kind: "too-large"; limit: number }
);
