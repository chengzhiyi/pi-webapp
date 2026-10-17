export type TerminalFrame =
  | { type: "snapshot"; screen: string; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; exitCode: number; signal?: number };

export const validTerminalSize = (cols: unknown, rows: unknown): boolean =>
  Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= 2 && Number(cols) <= 500 && Number(rows) >= 1 && Number(rows) <= 300;
