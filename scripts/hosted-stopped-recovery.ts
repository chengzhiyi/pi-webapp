import { resolve } from "node:path";
import { inspectStoppedStorage, recoverStoppedLocks, recoverStoppedFork, reconcileStoppedTransition, settleStoppedPair } from "../src/host/server/plugins/hosted/stopped-recovery.ts";

const [operation, root, a, b, c, ...extra] = process.argv.slice(2);
const valid = root && !extra.length && (
  operation === "inspect" && !a && !b && !c ||
  ["recover-locks", "settle-pair"].includes(operation ?? "") && a && b && !c ||
  ["recover-fork", "reconcile-transition"].includes(operation ?? "") && a && b && c
);
if (!valid) {
  console.error("Offline only. Usage: node --experimental-strip-types scripts/hosted-stopped-recovery.ts\n  inspect BROKER_ROOT | HOSTED_ROOT/host-pair\n  recover-locks BROKER_ROOT FINGERPRINT CONFIRMATION\n  reconcile-transition DATA_ROOT PLUGIN_ID FINGERPRINT CONFIRMATION\n  recover-fork DATA_ROOT PLUGIN_ID FINGERPRINT CONFIRMATION\n  settle-pair HOSTED_ROOT FINGERPRINT CONFIRMATION\nCONFIRMATION = ALL_HOSTS_AND_PLUGIN_WORKERS_STOPPED_AND_BACKUP_VERIFIED");
  process.exitCode = 2;
} else {
  try {
    const path = resolve(root!);
    const result = operation === "inspect" ? await inspectStoppedStorage(path) :
      operation === "recover-locks" ? await recoverStoppedLocks(path, a!, b!) :
      operation === "settle-pair" ? await settleStoppedPair(path, a!, b!) :
      operation === "recover-fork" ? await recoverStoppedFork(path, a!, b!, c!) : await reconcileStoppedTransition(path, a!, b!, c!);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; }
}
