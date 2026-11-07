/** The workspace tab a prompt was addressed to from the floating composer. */
export interface WorkspaceTabContext {
  title: string; kind: string; contentId: string; plugin?: string;
  /** Shown to the user beside the title ("package.json · L55–80"). */
  detail?: string;
  /** Reported by the tab for the agent ("Open file: …; selected lines …"). */
  reference?: string;
}

const CONTEXT_MARKER = "[pi-web workspace tab in view] ";
/** Tells the agent what to do with the reference; parsing tolerates its absence (older prompts). */
const CONTEXT_GUIDANCE = " — The user wrote this while looking at that workspace tab. Read \"this\", \"here\" or \"current\" as its content, and when a tool can act on that content (for example read and patch the open drawing or file), act on it in place instead of creating something new.";

/**
 * Append the agent-facing tab reference after the user's text. Like the bridge's
 * attachment lines, it travels inside the prompt and the transcript hides it.
 */
export function withWorkspaceContext(text: string, context: WorkspaceTabContext | null | undefined): string {
  if (!context) return text;
  const payload = pickContext(context);
  return [text, `${CONTEXT_MARKER}${JSON.stringify(payload)}${CONTEXT_GUIDANCE}`].filter(Boolean).join("\n\n");
}

function pickContext(value: WorkspaceTabContext): WorkspaceTabContext {
  return {
    title: value.title, kind: value.kind, contentId: value.contentId,
    ...(value.plugin ? { plugin: value.plugin } : {}), ...(value.detail ? { detail: value.detail } : {}), ...(value.reference ? { reference: value.reference } : {}),
  };
}

function parseContext(line: string): WorkspaceTabContext | null {
  const json = line.endsWith(CONTEXT_GUIDANCE) ? line.slice(0, -CONTEXT_GUIDANCE.length) : line;
  try {
    const value = JSON.parse(json) as Partial<WorkspaceTabContext>;
    if (typeof value.title !== "string" || typeof value.kind !== "string" || typeof value.contentId !== "string") return null;
    for (const key of ["plugin", "detail", "reference"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return null;
    return pickContext(value as WorkspaceTabContext);
  } catch { return null; }
}

/** Separate pi-web's agent-facing attachment paths and tab reference from the user's message. */
export function displayUserMessage(text: string): { text: string; attachments: Array<{ name: string; image: boolean }>; context?: WorkspaceTabContext } {
  const attachments: Array<{ name: string; image: boolean }> = [];
  let visible = text;
  while (true) {
    const match = /(^|\n\n)附件 ("(?:\\.|[^"\\])*")：([^\n]+)$/u.exec(visible);
    if (!match || !/[\\/]pi-web[\\/]attachments[\\/][a-f0-9]{64}[\\/]/u.test(match[3]!)) break;
    let name: string;
    try { name = JSON.parse(match[2]!) as string; }
    catch { break; }
    attachments.unshift({ name, image: /\.(?:png|jpe?g|webp|gif)$/iu.test(name) });
    visible = visible.slice(0, match.index);
  }
  const marker = visible.lastIndexOf(CONTEXT_MARKER);
  if (marker !== -1 && (marker === 0 || visible.slice(marker - 2, marker) === "\n\n") && !visible.slice(marker).includes("\n")) {
    const context = parseContext(visible.slice(marker + CONTEXT_MARKER.length));
    if (context) return { text: visible.slice(0, Math.max(0, marker - 2)), attachments, context };
  }
  return { text: visible, attachments };
}
