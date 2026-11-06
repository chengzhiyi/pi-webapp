import { TERMINAL_AGENT_INPUT_LIMIT, TERMINAL_READ_LINE_LIMIT } from "../contract/terminal.ts";
import type { SessionTerminal, TerminalRegistry } from "./terminals.ts";

const TERMINAL_ID = /^[a-f0-9-]{36}$/i;
const OUTPUT_CHAR_LIMIT = 32 * 1024;
const QUIET_MS = 300;
const MAX_WAIT_MS = 30_000;

export interface TerminalSendInput { terminalId: string; text: string; enter: boolean; waitMs: number; lines: number }
export interface TerminalAgentResult { terminalId: string; output: string; truncated: boolean; exitCode?: number }

const control = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid terminal tool input");
  return input as Record<string, unknown>;
};
function terminalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TERMINAL_ID.test(value)) throw new Error("terminalId must be the terminal tab's contentId");
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}

/** Validate a command line before the user is asked about it; the same value is what gets written. */
export function parseSend(input: unknown): Omit<TerminalSendInput, "terminalId"> & { terminalId?: string } {
  const value = record(input);
  if (typeof value.text !== "string") throw new Error("text must be a string");
  const text = value.text.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(text) > TERMINAL_AGENT_INPUT_LIMIT) throw new Error(`text is longer than ${TERMINAL_AGENT_INPUT_LIMIT} bytes`);
  // Control characters other than tab and newline would be invisible in the approval prompt.
  if ([...text].some(char => char !== "\t" && char !== "\n" && control(char.charCodeAt(0)))) throw new Error("text may not contain control characters other than tab and newline");
  if (value.enter !== undefined && typeof value.enter !== "boolean") throw new Error("enter must be a boolean");
  const enter = value.enter ?? true;
  if (!text && !enter) throw new Error("Nothing to send");
  return {
    terminalId: terminalId(value.terminalId), text, enter,
    waitMs: integer(value.waitMs, 3000, 0, MAX_WAIT_MS, "waitMs"),
    lines: integer(value.lines, 40, 1, TERMINAL_READ_LINE_LIMIT, "lines"),
  };
}

/** Printable text of raw terminal output, ignoring escape sequences, backspaced characters and whitespace. */
export function visibleText(raw: string): string {
  let text = "";
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code === 0x1b) {
      const next = raw[index + 1];
      if (next === "]") {
        // OSC (window title, cwd) ends with BEL or ESC \.
        index += 2;
        while (index < raw.length && raw.charCodeAt(index) !== 0x07 && raw.charCodeAt(index) !== 0x1b) index++;
        if (raw.charCodeAt(index) === 0x1b) index++;
      } else if (next === "[") {
        // CSI parameters run until a final byte in @..~.
        index += 2;
        while (index < raw.length && (raw.charCodeAt(index) < 0x40 || raw.charCodeAt(index) > 0x7e)) index++;
      } else index += next === "(" || next === ")" ? 2 : 1;
      continue;
    }
    if (code === 0x08) text = text.slice(0, -1);
    else if (!control(code) && !/\s/u.test(raw[index]!)) text += raw[index];
  }
  return text;
}
/** True once output shows more than the shell echoing what was typed (output, or the next prompt). */
const beyondEcho = (typed: string) => {
  const echo = visibleText(typed);
  return (seen: string) => { const shown = visibleText(seen); return !!shown && !echo.startsWith(shown); };
};

async function view(id: string, terminal: SessionTerminal, lines: number): Promise<TerminalAgentResult> {
  const text = await terminal.text(lines);
  const truncated = text.length > OUTPUT_CHAR_LIMIT;
  return { terminalId: id, output: truncated ? text.slice(-OUTPUT_CHAR_LIMIT) : text, truncated, ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }) };
}

/**
 * Model-facing terminal operations, always scoped to the calling session's own terminals.
 * "send" writes without asking: the agent tool obtains the user's approval for the exact text first.
 */
export async function terminalAgentAction(registry: TerminalRegistry, sessionId: string, action: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
  if (action === "prepare") {
    const send = parseSend(input);
    const { id, terminal } = registry.resolve(send.terminalId, sessionId);
    if (!terminal.running) throw new Error("The terminal's shell has exited. Ask the user to open a new terminal.");
    return { terminalId: id };
  }
  if (action === "send") {
    const send = parseSend(input);
    if (!send.terminalId) throw new Error("terminalId is required");
    const { id, terminal } = registry.resolve(send.terminalId, sessionId);
    signal?.throwIfAborted();
    terminal.write(send.text.replace(/\n/g, "\r") + (send.enter ? "\r" : ""));
    // A busy or still-starting shell only echoes the text at first; wait for what follows.
    if (send.waitMs) await terminal.settle(QUIET_MS, send.waitMs, signal, beyondEcho(send.text));
    return view(id, terminal, send.lines);
  }
  if (action === "read") {
    const value = record(input);
    const { id, terminal } = registry.resolve(terminalId(value.terminalId), sessionId);
    return view(id, terminal, integer(value.lines, 100, 1, TERMINAL_READ_LINE_LIMIT, "lines"));
  }
  throw new Error(`Unknown terminal action: ${action}`);
}
