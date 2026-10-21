import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectMacAppSignature } from "./desktop-signing.mjs";

const execute = promisify(execFile);

/** Verify the actual distributables, not just the pre-archive build directory.
 * The DMG is mounted read-only; neither app is launched or re-signed here.
 */
export async function verifyMacArchives({ dmg, zip, signing, run = execute, inspectSignature = inspectMacAppSignature }) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-archive-signature-"));
  const mount = join(temporary, "dmg");
  const extracted = join(temporary, "zip");
  let attached = false;
  try {
    await mkdir(mount);
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, resolve(dmg)], { timeout: 120000 });
    attached = true;
    assert.deepEqual(await inspectSignature(join(mount, "pi.app")), signing, "DMG signature differs from the packaged app");
    await run("/usr/bin/ditto", ["-x", "-k", resolve(zip), extracted], { timeout: 120000 });
    assert.deepEqual(await inspectSignature(join(extracted, "pi.app")), signing, "ZIP signature differs from the packaged app");
  } finally {
    // If detach fails, preserve the mountpoint rather than recursively deleting it.
    if (attached) await run("/usr/bin/hdiutil", ["detach", mount], { timeout: 30000 });
    await rm(temporary, { recursive: true, force: true });
  }
}
