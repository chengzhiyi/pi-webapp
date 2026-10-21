import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Build/release gate, not a Gatekeeper or notarization claim. Never repair a
 * signature here: reject broken packages rather than bless modified contents.
 */
export async function inspectMacAppSignature(appPath, run = execute) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 120000 });
  const { stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], { timeout: 10000 });
  assert.match(stderr, /^Sealed Resources[ =]version=/m, "macOS app must have a complete resource seal");
  if (/^Signature=adhoc$/m.test(stderr)) return { type: "ad-hoc", verified: true };
  assert.match(stderr, /^Authority=Developer ID Application:/m, "expected ad-hoc or Developer ID Application signature");
  assert.match(stderr, /^TeamIdentifier=[A-Z0-9]{10}$/m, "publisher signature needs a TeamIdentifier");
  return { type: "developer-id", verified: true };
}

export function validateSigningManifest(signing, unsigned) {
  assert.equal(signing?.verified, true, "release needs verified macOS signature integrity");
  assert.ok(["ad-hoc", "developer-id"].includes(signing.type), "unknown macOS signing type");
  assert.equal(unsigned, signing.type === "ad-hoc", "signing type must agree with publisher-signature status");
}
