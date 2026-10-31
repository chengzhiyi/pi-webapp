import { stat } from "node:fs/promises";

/** Marker removal is a refusal only while the same owner is still published.
 * Normal exit removes its state first; sample again after observing removal to
 * avoid interpreting a completed teardown as a rejected save/drain.
 */
export async function observeStopOutcome(activeState, stopPath, nonce) {
  const current = await activeState();
  if (!current || current.nonce !== nonce) return "stopped";
  try { await stat(stopPath); return "pending"; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const latest = await activeState();
    return !latest || latest.nonce !== nonce ? "stopped" : "refused";
  }
}
