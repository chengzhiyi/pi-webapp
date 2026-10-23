import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopProtocolVersion } from "../../managed-release.mjs";

const source = fileURLToPath(new URL("../../../", import.meta.url));
export const fakePi = `import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
const extension = process.argv[process.argv.indexOf('-e') + 1];
const current = JSON.parse(readFileSync(resolve(dirname(extension), '../package.json'), 'utf8')).version;
const token = process.env.PI_WEBAPP_RESTART_TOKEN || 'a'.repeat(32);
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({current, desktopProtocolVersion: 1}));
});
createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if (request.type === 'get_commands') console.log(JSON.stringify({type:'response', id:request.id, success:true, data:{commands:[{name:'web',source:'extension',sourceInfo:{path:extension}}]}}));
 else server.listen(Number(process.env.PI_WEBAPP_RESTART_PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({type:'extension_ui_request',method:'notify',message:'pi-webapp: http://127.0.0.1:'+server.address().port+'/#'+token})));
});
process.stdin.on('end', () => server.close(() => process.exit(0)));
`;

/** A real launcher/HTTP lifecycle, but no model requests, npm or user state. */
export async function stageRuntime(agentDir, version, { broken = false } = {}) {
  const prefix = join(agentDir, "pi-web", "releases", `${version}-fixture`);
  const root = join(prefix, "node_modules", "pi-webapp");
  await mkdir(join(root, "desktop"), { recursive: true });
  await cp(join(source, "bin"), join(root, "bin"), { recursive: true });
  await cp(join(source, "desktop", "managed-release.mjs"), join(root, "desktop", "managed-release.mjs"));
  for (const path of ["dist", "web/dist", "node_modules"]) await mkdir(join(root, path), { recursive: true });
  await symlink(join(source, "node_modules", "cross-spawn"), join(root, "node_modules", "cross-spawn"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-webapp", version, type: "module", piWebappDesktopProtocol: 1 }));
  await writeFile(join(root, "dist", "extension.js"), "");
  await writeFile(join(root, "web", "dist", "index.html"), "");
  const piRoot = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(join(piRoot, "dist", "bundle"), { recursive: true });
  await writeFile(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.3.0", type: "module" }));
  const piCli = join(piRoot, "dist", "bundle", "cli.js");
  await writeFile(piCli, broken ? "process.exit(3);" : fakePi);
  return { version, launcher: join(root, "bin", "pi-webapp.mjs"), piCli, desktopProtocolVersion };
}
