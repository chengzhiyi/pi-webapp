import type { TabContextReport } from "../../../../contracts/workbench.ts";

export interface LineRange { from: number; to: number }

/** What a Files tab tells the agent about "this file" / "these lines". */
export function fileContext(cwd: string, path: string | undefined, lines: LineRange | null): TabContextReport | null {
  if (!path) return null;
  const name = path.split("/").at(-1) ?? path;
  const span = lines ? (lines.from === lines.to ? `L${lines.from}` : `L${lines.from}–${lines.to}`) : "";
  const absolute = `${cwd.replace(/[\\/]+$/u, "")}/${path}`;
  return {
    detail: span ? `${name} · ${span}` : name,
    reference: `Open file: ${path} (absolute: ${absolute}).${lines ? ` Selected lines ${lines.from}–${lines.to}.` : ""}`,
  };
}
