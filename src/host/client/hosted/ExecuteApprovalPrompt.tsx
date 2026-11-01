import type { HostedExecuteApproval } from "../../../contracts/hosted-plugins.ts";

const text = {
  zh: { title: "插件请求执行权限", body: (plugin: string, title: string) => `${plugin} 想让后台会话「${title}」获得写入与命令权限（此前只读）。`, allow: "允许", deny: "拒绝" },
  en: { title: "A plugin requests permission to execute", body: (plugin: string, title: string) => `${plugin} wants background session "${title}" to gain write and command access (read-only until now).`, allow: "Allow", deny: "Deny" },
};
/** Explicit human gate: one prompt per request, never auto-dismissed, no remembered consent. */
export function ExecuteApprovalPrompt({ approvals, locale, decide }: { approvals: HostedExecuteApproval[]; locale: "zh" | "en"; decide(id: string, decision: "allow" | "deny"): void }) {
  const t = text[locale];
  if (!approvals.length) return null;
  return <section role="alertdialog" aria-label={t.title} style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1000, maxWidth: 420, padding: 12, borderRadius: 8, background: "var(--pi-surface, #fff)", color: "var(--pi-text, #111)", border: "1px solid var(--pi-border, #888)", boxShadow: "0 4px 16px rgba(0,0,0,.25)" }}>
    <strong>{t.title}</strong>
    {approvals.map(item => <div key={item.id} style={{ marginTop: 8 }}>
      <p style={{ margin: "0 0 6px" }}>{t.body(item.pluginId, item.title)}</p>
      <button type="button" onClick={() => decide(item.id, "allow")}>{t.allow}</button>{" "}
      <button type="button" onClick={() => decide(item.id, "deny")}>{t.deny}</button>
    </div>)}
  </section>;
}
