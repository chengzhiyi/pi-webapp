export type TerminalFrame =
  | { type: "snapshot"; screen: string; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; exitCode: number; signal?: number };

export const validTerminalSize = (cols: unknown, rows: unknown): boolean =>
  Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= 2 && Number(cols) <= 500 && Number(rows) >= 1 && Number(rows) <= 300;

/** Interaction the agent opens before it types into a terminal; the user must allow each one. */
export const TERMINAL_INPUT_APPROVAL = "terminal-input";
export interface TerminalInputApproval { terminalId: string; text: string; enter: boolean }
export type TerminalInputDecision = { allow: boolean };
/** Agent input is a command line, not a paste: keep it short enough to read in the prompt. */
export const TERMINAL_AGENT_INPUT_LIMIT = 4096;
export const TERMINAL_READ_LINE_LIMIT = 500;
