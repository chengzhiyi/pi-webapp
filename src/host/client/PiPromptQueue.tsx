import type { SessionView } from "../../contracts/bridge-contract.ts";
import { displayUserMessage } from "../../contracts/user-message.ts";
import { localize as t } from "../../../web/src/ui/locale/preference.ts";

/** Read-only native queue projection; never a second browser-owned work queue. */
export function PiPromptQueue({ session }: { session: SessionView | null }) {
  const queue = session?.promptQueue;
  const entries = [
    ...(queue?.steering ?? []).map(text => ({ label: t("引导", "Steer"), text })),
    ...(queue?.followUp ?? []).map(text => ({ label: t("排队", "Queue"), text })),
  ];
  if (!entries.length && !session?.hasPendingPrompts) return null;
  return <section className="pi-prompt-queue" aria-label={t("待处理提示词", "Pending prompts")}>
    <div role="status">{t("等待 Pi 接收", "Waiting for Pi")}{entries.length > 0 ? ` · ${entries.length}` : ""}{session?.paused ? t(" · 已暂停，继续后处理", " · Paused; processed on resume") : ""}</div>
    {entries.length > 0 && <ol>{entries.map((entry, index) => {
      const displayed = displayUserMessage(entry.text);
      return <li key={index}><strong>{entry.label}</strong><span>{[displayed.text, ...displayed.attachments.map(file => file.name)].filter(Boolean).join(" · ")}</span></li>;
    })}</ol>}
  </section>;
}
