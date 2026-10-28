// Test-only filesystem instrumentation, inherited by real RPC subprocesses.
// Force the rejected stop request to remain visible across multiple timer ticks.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const unlink = fs.promises.unlink;
let delayed = false;
fs.promises.unlink = async function (path, ...args) {
  if (!delayed && String(path).endsWith('/launcher.stop')) {
    delayed = true;
    await delay(1200);
  }
  return unlink.call(this, path, ...args);
};
syncBuiltinESMExports();
