import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { hash, releaseIdentity, releaseNotes, releaseTargets } from "../../scripts/desktop-release.mjs";
import { publishRelease } from "../../scripts/publish-desktop-release.mjs";

const sig = "desktop-release.json.sig";
const repository = "owner/project", sourceCommit = "a".repeat(40);
const keyPair = (type = "ed25519") => generateKeyPairSync(type, {
  ...(type === "ec" ? { namedCurve: "prime256v1" } : {}),
  privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-manifest-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "bundle"), keyPath = join(root, "desktop/update-project-key.pem");
  for (const path of [directory, join(root, "desktop"), join(root, "docs/en")]) await mkdir(path, { recursive: true });
  const pkg = { version: "0.1.21", devDependencies: { "@earendil-works/pi-coding-agent": "1.3.0" } };
  const release = { productName: "pi", buildNumber: 6 };
  const whatsNew = "- Release fixture.";
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(join(root, "desktop/release.json"), JSON.stringify(release));
  await writeFile(join(root, "docs/en/changelog.md"), `## Desktop build 6 · pi 0.1.21 · 2026-10-21 {#build-6}\n\n${whatsNew}\n`);
  const shared = { productName: "pi", repository, sourceCommit, unsigned: true, notarized: false, prerelease: true };
  const targets = [];
  for (const { id, platform, arch } of releaseTargets) {
    const spec = releaseIdentity(pkg, release, { platform, arch });
    const bytes = Buffer.from(`installer ${id}`);
    await writeFile(join(directory, spec.filename), bytes);
    targets.push({ ...shared, ...spec, schemaVersion: 1, target: id, platform, arch,
      ...(platform === "darwin" ? { signing: { type: "ad-hoc", verified: true } } : {}),
      runtime: { nodeVersion: "24.0.0", piVersion: "1.3.0", nodeArchiveSha256: "b".repeat(64) },
      smokeChecks: ["native-name-menu-title-pi", "custom-app-icon-loads", "native-pty", "shared-browser-backend", "confirmed-stop-reaps-pi",
        "installer-payload-launch", "native-desktop-update-menu", "native-desktop-update-download"],
      asset: { name: spec.filename, bytes: bytes.length, sha256: hash(bytes) } });
  }
  const { version, build, tag } = targets[0];
  const assets = targets.map(target => target.asset);
  const manifest = { ...shared, schemaVersion: 2, version, build, tag, targets, assets };
  // Valid JSON but deliberately not the result of a parse/re-serialize round trip.
  const manifestBytes = Buffer.from(` \r\n${JSON.stringify(manifest, null, 3).replaceAll("\n", "\r\n")}\r\n\t`);
  const files = { "desktop-release.json": manifestBytes, SHA256SUMS: assets.map(({ sha256, name }) => `${sha256}  ${name}\n`).join(""),
    "release-notes.md": releaseNotes(manifest, whatsNew) };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  return { directory, keyPath, manifestBytes, publish: options => publishRelease({ root, directory, repository, sourceCommit, ...options }) };
}

function githubMock() {
  const files = new Map(), commands = [];
  let exists = false, draft = true, corruptSignature = false;
  return { files, commands, get draft() { return draft; }, corruptSignature() { corruptSignature = true; }, run(args) {
    if (args[0] === "api") {
      if (args[1].includes("/git/ref/")) return JSON.stringify({ object: { type: "commit", sha: sourceCommit } });
      if (!exists) throw Object.assign(new Error("not found"), { stderr: "HTTP 404" });
      return JSON.stringify({ draft, prerelease: true, assets: [...files.keys()].map(name => ({ name, state: "uploaded" })) });
    }
    const command = args[1]; commands.push(command);
    if (command === "create") exists = true;
    else if (command === "upload") {
      assert.equal(draft, true);
      for (const filename of args.slice(args.indexOf("--clobber") + 1)) files.set(basename(filename), readFileSync(filename));
    } else if (command === "download") {
      const directory = args[args.indexOf("--dir") + 1];
      for (const [i, arg] of args.entries()) if (arg === "--pattern") {
        const name = args[i + 1];
        writeFileSync(join(directory, name), corruptSignature && name === sig ? Buffer.alloc(64) : files.get(name));
      }
    } else if (command === "edit") draft = false;
    else assert.fail(`unexpected release command: ${command}`);
    return "";
  } };
}

test("publisher uploads and verifies a raw signature over the unchanged assembled bytes", async t => {
  const f = await fixture(t), { publicKey, privateKey } = keyPair(), gh = githubMock();
  await writeFile(f.keyPath, publicKey);
  await f.publish({ privateKeyPem: privateKey.replaceAll("\n", "\r\n"), run: gh.run });
  assert.deepEqual(gh.commands, ["create", "upload", "download", "edit"]);
  const signature = gh.files.get(sig);
  assert.equal(signature.length, 64);
  assert.deepEqual(gh.files.get("desktop-release.json"), f.manifestBytes);
  assert.deepEqual(await readFile(join(f.directory, "desktop-release.json")), f.manifestBytes);
  assert.ok(verify(null, f.manifestBytes, publicKey, signature));
  assert.ok(!verify(null, Buffer.from(JSON.stringify(JSON.parse(f.manifestBytes))), publicKey, signature));

  // Each workflow retry starts from the same unsigned assembly artifact.
  const retry = async () => { await rm(join(f.directory, sig)); return f.publish({ privateKeyPem: privateKey, run: gh.run }); };
  gh.commands.length = 0;
  assert.equal((await retry()).alreadyPublished, true);
  assert.deepEqual(gh.commands, ["download"]);
  gh.corruptSignature(); gh.commands.length = 0;
  await assert.rejects(retry(), /uploaded asset mismatch: desktop-release.json.sig/);
  assert.deepEqual(gh.commands, ["download"]);
});

test("a bad signature download blocks publication; an unsigned retry cannot publish a stale draft signature", async t => {
  const f = await fixture(t), { publicKey, privateKey } = keyPair(), gh = githubMock();
  await writeFile(f.keyPath, publicKey);
  gh.corruptSignature();
  await assert.rejects(f.publish({ privateKeyPem: privateKey, run: gh.run }), /uploaded asset mismatch: desktop-release.json.sig/);
  assert.equal(gh.draft, true);
  await rm(join(f.directory, sig)); await rm(f.keyPath);
  gh.commands.length = 0;
  await assert.rejects(f.publish({ run: gh.run }), /stale signature/);
  assert.deepEqual(gh.commands, []);
});

test("unsigned publication is optional, but signed and unsigned published releases cannot replace each other", async t => {
  const f = await fixture(t), gh = githubMock(), { publicKey, privateKey } = keyPair();
  await f.publish({ privateKeyPem: "", run: gh.run });
  assert.equal(gh.files.has(sig), false);
  await writeFile(f.keyPath, publicKey);
  gh.commands.length = 0;
  await assert.rejects(f.publish({ privateKeyPem: privateKey, run: gh.run }), /published release signature configuration differs/);
  await rm(f.keyPath); await rm(join(f.directory, sig));
  gh.files.set(sig, Buffer.alloc(64));
  await assert.rejects(f.publish({ run: gh.run }), /published release signature configuration differs/);
  assert.deepEqual(gh.commands, []);
});

test("partial, malformed, mismatched and preexisting signature configurations fail before GitHub", async t => {
  const f = await fixture(t), { publicKey, privateKey } = keyPair(), other = keyPair(), ec = keyPair("ec");
  const run = () => assert.fail("must not reach GitHub");
  await assert.rejects(f.publish({ privateKeyPem: privateKey, run }), /requires both/);
  await writeFile(f.keyPath, publicKey);
  await assert.rejects(f.publish({ privateKeyPem: "", run }), /requires both/);
  await assert.rejects(f.publish({ privateKeyPem: "not a PEM", run }), /PRIVATE_KEY must contain/);
  await assert.rejects(f.publish({ privateKeyPem: ec.privateKey, run }), /PRIVATE_KEY must contain/);
  await assert.rejects(f.publish({ privateKeyPem: other.privateKey, run }), /does not verify/);
  for (const invalid of ["", privateKey, ec.publicKey]) {
    await writeFile(f.keyPath, invalid);
    await assert.rejects(f.publish({ privateKeyPem: privateKey, run }), /update-project-key.pem must contain/);
  }
  await writeFile(f.keyPath, publicKey);
  await writeFile(join(f.directory, sig), Buffer.alloc(64));
  await assert.rejects(f.publish({ privateKeyPem: privateKey, run }), /unexpected or missing release files/);
});

test("only protected publication references the manifest signing secret", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  const publish = workflow.indexOf("\n  publish:");
  assert.ok(publish > 0);
  assert.doesNotMatch(workflow.slice(0, publish), /PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY/);
  assert.match(workflow.slice(publish), /\n    environment: desktop-release\n/);
  assert.match(workflow.slice(publish), /PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY: \$\{\{ secrets\.PI_WEBAPP_DESKTOP_UPDATE_PRIVATE_KEY \}\}\n        run: \|\n          export DESKTOP_SOURCE_COMMIT=.*\n          node scripts\/publish-desktop-release\.mjs/);
});
