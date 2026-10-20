/** Separate pi-web's agent-facing attachment paths from the user's message. */
export function displayUserMessage(text: string): { text: string; attachments: Array<{ name: string; image: boolean }> } {
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
  return { text: visible, attachments };
}
