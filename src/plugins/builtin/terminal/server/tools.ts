import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WebInteraction } from "@chengzhiyi/pi-web-protocol";
import { BUILTIN_IDS } from "../../../../contracts/plugins.ts";
import { TERMINAL_AGENT_INPUT_LIMIT, TERMINAL_INPUT_APPROVAL, TERMINAL_READ_LINE_LIMIT, type TerminalInputApproval } from "../contract/terminal.ts";
import { parseSend, type TerminalAgentResult } from "./agent.ts";

export interface TerminalToolHost {
  /** The terminal plugin's session-scoped agent action (prepare, send, read). */
  run(cwd: string, sessionId: string, action: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Show an interaction in this session's Web UI and resolve with the user's answer. */
  ask(request: WebInteraction, signal?: AbortSignal): Promise<unknown>;
}

const terminalId = Type.String({ pattern: "^[a-fA-F0-9-]{36}$", description: "The terminal tab's contentId, for example from the [pi-web workspace tab in view] line of kind \"terminal\". Optional when this session has exactly one open terminal." });
const lines = (fallback: number) => Type.Optional(Type.Integer({ minimum: 1, maximum: TERMINAL_READ_LINE_LIMIT, description: `How many trailing lines of the terminal to return (default ${fallback}).` }));

function result(value: TerminalAgentResult, prefix = "") {
  const status = value.exitCode === undefined ? "" : ` The shell has exited with code ${value.exitCode}.`;
  const text = `${prefix}Terminal ${value.terminalId}${value.truncated ? " (output truncated to the most recent part)" : ""}:${status}\n${value.output}`;
  return { content: [{ type: "text" as const, text }], details: value };
}

/**
 * Let the agent act on the user's own workspace terminal tabs. Reading is scoped to the session's
 * terminals; every write first asks the user to allow the exact text in the Web UI.
 */
export function terminalTools(host: TerminalToolHost): ToolDefinition[] {
  return [{
    name: "terminal_send", label: "terminal_send",
    description: "Type a command into one of the user's open workspace terminal tabs (their live interactive shell) and return the terminal's recent output. Use this when the user asks you to run something in \"this\"/\"the\" terminal they are looking at; for your own work use bash instead. The user must approve each call in the Web UI before anything is typed, so send one complete command at a time and do not assume it ran if the call fails. Enter is pressed after the text unless enter is false. Output is read after the terminal is quiet for a moment or waitMs passes; for long-running commands call terminal_read later.",
    parameters: Type.Object({
      terminalId: Type.Optional(terminalId),
      text: Type.String({ maxLength: TERMINAL_AGENT_INPUT_LIMIT, description: "Text to type. Newlines separate lines; no other control characters." }),
      enter: Type.Optional(Type.Boolean({ description: "Press Enter after the text (default true)." })),
      waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Longest time to wait for output before returning (default 3000)." })),
      lines: lines(40),
    }),
    async execute(_callId, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      const sessionId = ctx.sessionManager.getSessionId();
      const send = parseSend(input);
      const { terminalId } = await host.run(ctx.cwd, sessionId, "prepare", input, signal) as { terminalId: string };
      const data: TerminalInputApproval = { terminalId, text: send.text, enter: send.enter };
      const decision = await host.ask({ requestId: randomUUID(), sessionId, pluginId: BUILTIN_IDS.terminal, kind: TERMINAL_INPUT_APPROVAL, data }, signal);
      if (!decision || typeof decision !== "object" || (decision as { allow?: unknown }).allow !== true) throw new Error("The user declined; nothing was typed into the terminal.");
      return result(await host.run(ctx.cwd, sessionId, "send", { ...send, terminalId }, signal) as TerminalAgentResult, "Sent after the user approved. ");
    },
  }, {
    name: "terminal_read", label: "terminal_read",
    description: "Read the recent text of one of the user's open workspace terminal tabs (scrollback included, plain text). Use it to see what the user is looking at in a terminal or to check on a command started with terminal_send. Does not type anything.",
    parameters: Type.Object({ terminalId: Type.Optional(terminalId), lines: lines(100) }),
    async execute(_callId, input, signal, _update, ctx) {
      signal?.throwIfAborted();
      return result(await host.run(ctx.cwd, ctx.sessionManager.getSessionId(), "read", input, signal) as TerminalAgentResult);
    },
  }];
}
