// Fetch immutable published first-party fixtures; never install or run package scripts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.env.RUNNER_TEMP ?? '.paperclip', 'hosted-public-fixtures');
await mkdir(root, { recursive: true });
const fixtures = [
  ['HOSTED_EXCALIDRAW_TGZ', '@chengzhiyi/pi-excalidraw@0.1.0', 'sha512-9VRKpQT8RQqk6UBaNyZlKHy5vWLNCfYbQTRzaAhC8HMJ0DsoIu3sVs2YrNxyPaNDr9iDbetWrZT2hAJEXHdd4g=='],
  // Native host chrome requires the optional UI handshake introduced by this
  // reviewed release. Keep the legacy fixture above for compatibility coverage.
  ['HOSTED_TOOL_UI_TGZ', '@chengzhiyi/pi-excalidraw@0.1.3', 'sha512-MZVgRbPczTsG+nkLoT+NDs0ClU67BVEGmbefPHQZitHoKy5m2tMliiDojSEkHf+nruWEBB7JQDUpzb7+N8VGZQ==', 'd419333729106787d069ca9617a7637b66d4280d'],
  ['HOSTED_PLAN_V1_TGZ', '@chengzhiyi/pi-plan-mode@0.1.1', 'sha512-7tBJk+WTJg9xH6MInFCzx5d7Yz1u8nNAnhnSyI0ZO8jmO467et6bpomjyvFSCH1fxRnQ4aCV35C0Hih7JTDxSA=='],
];
// Immutable regression archives stay pinned below. The separate public UI gate
// selects the current compatible release rather than assuming latest is 0.1.1.
const environment = { HOSTED_STRESS: '1', HOSTED_NPM_VERIFY: '1' };
const receipts = [];
for (const [key, specifier, expected, source] of fixtures) {
  const output = execFileSync('npm', ['pack', specifier, '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org', '--pack-destination', root], { encoding: 'utf8', shell: process.platform === 'win32' });
  const [receipt] = JSON.parse(output);
  const file = join(root, receipt.filename);
  const actual = 'sha512-' + createHash('sha512').update(await readFile(file)).digest('base64');
  if (actual !== expected || receipt.integrity !== expected) throw new Error(`Published fixture integrity mismatch: ${specifier}`);
  if (source) {
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }));
    if (manifest.piRelease?.source !== source) throw new Error(`Published fixture source mismatch: ${specifier}`);
  }
  environment[key] = file;
  receipts.push({ specifier, integrity: actual, filename: receipt.filename, ...(source ? { source } : {}) });
}
// These older regression fixtures also bind SHA-256 independently of metadata.
environment.HOSTED_EXCALIDRAW_SHA256 = 'c7aeef4d1546b5f0dec9743319f68b1cda217ffef60d53f9b8c66e754359c583';
environment.ORI38_EXCALIDRAW_TGZ = environment.HOSTED_EXCALIDRAW_TGZ;
environment.ORI38_EXCALIDRAW_SHA256 = environment.HOSTED_EXCALIDRAW_SHA256;
if (createHash('sha256').update(await readFile(environment.HOSTED_EXCALIDRAW_TGZ)).digest('hex') !== environment.HOSTED_EXCALIDRAW_SHA256) throw new Error('Published drawing fixture SHA-256 mismatch');
await writeFile(join(root, 'receipts.json'), JSON.stringify(receipts, null, 2));
if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([key, value]) => `${key}=${value}\n`).join(''));
console.log(JSON.stringify({ environment, receipts }, null, 2));
