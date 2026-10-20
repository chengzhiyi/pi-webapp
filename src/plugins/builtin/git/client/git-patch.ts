export interface GitPatchLine {
  kind: "add" | "remove" | "context" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Unified patches retain both line numbers, including resets between renamed file patches. */
export function parseGitPatch(patch: string): GitPatchLine[] {
  let oldLine = 0, newLine = 0, hunk = false;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(text => {
    const header = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (text.startsWith("diff --git ")) hunk = false;
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); hunk = true; }
    if (hunk && !header) {
      if (text.startsWith("+")) return { kind: "add", text, oldLine: null, newLine: newLine++ };
      if (text.startsWith("-")) return { kind: "remove", text, oldLine: oldLine++, newLine: null };
      if (text.startsWith(" ")) return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
    }
    return { kind: "meta", text, oldLine: null, newLine: null };
  });
}

export interface GitPreviewLine extends Omit<GitPatchLine, "kind"> {
  kind: "add" | "remove" | "context" | "hunk";
  change: number | null;
  noNewline?: boolean;
}
export interface GitPatchNotice {
  kind: "mode" | "rename" | "copy" | "added" | "deleted";
  from: string;
  to: string;
}

/** Strip transport headers only after parsing, so header-looking source stays intact. */
export function previewGitPatch(patch: string): { lines: GitPreviewLine[]; changes: number[]; notices: GitPatchNotice[] } {
  const lines: GitPreviewLine[] = [], changes: number[] = [], notices: GitPatchNotice[] = [];
  let change: number | null = null;
  let oldMode = "", renameFrom = "", copyFrom = "";
  for (const line of parseGitPatch(patch)) {
    if (line.kind !== "meta") {
      if (line.kind === "context") change = null;
      else if (change === null) { change = changes.length; changes.push(lines.length); }
      lines.push({ ...line, kind: line.kind, change });
      continue;
    }
    const hunk = line.text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    if (hunk) {
      change = null;
      lines.push({ kind: "hunk", oldLine: Number(hunk[1]), newLine: Number(hunk[2]), text: hunk[3]!, change: null });
    } else if (line.text === "\\ No newline at end of file") {
      const previous = lines.at(-1);
      if (previous && previous.kind !== "hunk") previous.noNewline = true;
    } else if (line.text.startsWith("diff --git ")) {
      change = null; oldMode = renameFrom = copyFrom = "";
    } else if (line.text.startsWith("old mode ")) oldMode = line.text.slice(9);
    else if (line.text.startsWith("new mode ")) notices.push({ kind: "mode", from: oldMode, to: line.text.slice(9) });
    else if (line.text.startsWith("rename from ")) renameFrom = line.text.slice(12);
    else if (line.text.startsWith("rename to ")) notices.push({ kind: "rename", from: renameFrom, to: line.text.slice(10) });
    else if (line.text.startsWith("copy from ")) copyFrom = line.text.slice(10);
    else if (line.text.startsWith("copy to ")) notices.push({ kind: "copy", from: copyFrom, to: line.text.slice(8) });
    else if (line.text.startsWith("new file mode ")) notices.push({ kind: "added", from: "", to: line.text.slice(14) });
    else if (line.text.startsWith("deleted file mode ")) notices.push({ kind: "deleted", from: line.text.slice(18), to: "" });
  }
  return { lines, changes, notices: notices.filter(notice => !changes.length || (notice.kind !== "added" && notice.kind !== "deleted")) };
}
