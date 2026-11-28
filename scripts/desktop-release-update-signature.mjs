import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const signatureName = "desktop-release.json.sig";
const publicKeyPath = "desktop/update-project-key.pem";
const privateKeyName = "PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY";

function ed25519Pem(pem, label, parse, description) {
  const invalid = `${description} must contain a single Ed25519 ${label} PEM`;
  // Reject encrypted keys, extra PEM blocks, and (for the committed file) private keys.
  if (!new RegExp(`^-----BEGIN ${label}-----\\r?\\n(?:[A-Za-z0-9+/=]+\\r?\\n)+-----END ${label}-----$`).test(pem.trim())) {
    throw new Error(invalid);
  }
  let key;
  try { key = parse(pem.trim()); }
  catch { throw new Error(invalid); } // Do not include key material in release logs.
  if (key.asymmetricKeyType !== "ed25519") throw new Error(invalid);
  return key;
}

// Call only after verifying the exact unsigned bundle file set.
export async function signUpdateManifest({ root, directory, privateKeyPem = "" }) {
  const path = join(root, publicKeyPath);
  const publicInfo = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!publicInfo && privateKeyPem === "") return false; // An unset Actions secret is an empty string.
  assert.ok(publicInfo && privateKeyPem !== "", `manifest signing requires both ${publicKeyPath} and ${privateKeyName}`);
  assert.ok(publicInfo.isFile(), `${publicKeyPath} must be a regular file`);
  const publicKey = ed25519Pem(await readFile(path, "utf8"), "PUBLIC KEY", createPublicKey, publicKeyPath);
  const privateKey = ed25519Pem(privateKeyPem, "PRIVATE KEY", createPrivateKey, privateKeyName);
  const bytes = await readFile(join(directory, "desktop-release.json"));
  const signature = sign(null, bytes, privateKey);
  assert.ok(signature.length === 64 && verify(null, bytes, publicKey, signature), `manifest signature does not verify with ${publicKeyPath}`);
  await writeFile(join(directory, signatureName), signature, { flag: "wx" });
  return true;
}
