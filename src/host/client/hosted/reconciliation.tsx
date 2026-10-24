import { useState } from "react";
import { prior, forgetView } from "./view-journal.ts";
import { hostedApi } from "./api.ts";

/** A reload is NOT a handoff. Only an explicit decision for EACH lost capability retires it.
 * This journal identifies capabilities, never purports to contain the latest local draft.
 */
export function HostedReconciliation({ sessionId }: { sessionId?: string }) {
  const [pending, setPending] = useState(prior);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  return <>{pending.filter(item => item.sessionId === sessionId).map(item => <section role="alert" key={item.viewToken} data-unconfirmed-view={item.mountId}>
    <p>Unconfirmed previous-document {item.kind} view: {item.contentId ?? item.mountId} (generation {item.generation}). Its latest edits have NOT been acknowledged. A restored or newer drawing does not prove this view is safe.</p>
    <p>Check that this view is no longer open in another tab. Use the plugin's Download draft / local backup recovery first. If the latest draft cannot be recovered, discarding may permanently lose edits. Restore is a separate, explicit action and may replace the winning drawing.</p>
    <button disabled={working} onClick={() => {
      if (!window.confirm(`Discard ALL unconfirmed edits for ${item.kind} view ${item.mountId}? This does not save or restore them. Download any recoverable draft first.`)) return;
      setWorking(true); setError("");
      void hostedApi.view({ ...item, operation: "discard", confirmation: "discard-unconfirmed-edits" }).then(() => {
        forgetView(item.viewToken); setPending(value => value.filter(record => record.viewToken !== item.viewToken));
      }).catch(cause => setError(String(cause))).finally(() => setWorking(false));
    }}>Discard unconfirmed edits for this view</button>
  </section>)}{error && <p role="alert">{error}</p>}</>;
}
