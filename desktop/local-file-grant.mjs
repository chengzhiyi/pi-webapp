import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, statSync } from "node:fs";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const keyName = "native-files.key";
const tokenPattern = /^[A-Za-z0-9_-]{32}$/;
const grantPattern = /^[A-Za-z0-9_-]{43}$/;

/** A native launch must be local and attended; a loopback HTTP peer alone proves neither. */
export function localFilePlatform(platform = process.platform, env = process.env, consoleUser = () => statSync("/dev/console").uid, uid = process.getuid?.()) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.PI_WEBAPP_LISTEN_HOST === "0.0.0.0") return;
  if (platform === "win32" && /^(?:Console|RDP-Tcp#\d+)$/i.test(env.SESSIONNAME ?? "")) return platform;
  if (platform === "darwin" && uid) {
    try { if (uid === consoleUser()) return platform; } catch { /* No console session. */ }
  }
}

async function readKey(path) {
  const posix = process.platform !== "win32";
  const file = await open(path, constants.O_RDONLY | (posix ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== 32 || (posix && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) return;
    const key = Buffer.alloc(33);
    if ((await file.read(key)).bytesRead === 32) return key.subarray(0, 32);
  } finally { await file.close(); }
}

export async function localFileKey(agentDir, create = false) {
  const dir = join(agentDir, "pi-web");
  const path = join(dir, keyName);
  try { return await readKey(path); } catch (error) {
    if (!create || error?.code !== "ENOENT") return;
  }
  // Publish a complete private key atomically so sibling CLI/shell processes
  // and concurrent starts either see the same key or fail closed.
  const temporary = `${path}.${randomBytes(12).toString("hex")}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
    try { await link(temporary, path); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    return await readKey(path);
  } catch { /* Opening workspace files is optional; the web session still works. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function makeGrant(key, token) {
  return createHmac("sha256", key).update(`pi-web/native-files/v1\0${token}`).digest("base64url");
}

export function matchesLocalFileGrant(key, token, input) {
  return !!key && typeof input === "string" && grantPattern.test(input)
    && timingSafeEqual(Buffer.from(input), Buffer.from(makeGrant(key, token)));
}

function acceptsGrant(target, token, grant, platform) {
  // A direct, bounded loopback request: never send these headers through a
  // proxy, follow a redirect, or trust a generic success page from an old host.
  return new Promise(resolve => {
    const request = get(new URL("/api/local-file-actions", target), {
      agent: false, signal: AbortSignal.timeout(1500),
      headers: { Authorization: `Bearer ${token}`, "X-Pi-Local-Files": grant },
    }, response => {
      if (response.statusCode !== 200) { response.destroy(); resolve(false); return; }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        text += chunk;
        if (text.length > 256) { response.destroy(); resolve(false); }
      });
      response.once("end", () => {
        try { resolve(JSON.parse(text)?.platform === platform); } catch { resolve(false); }
      });
      response.once("error", () => resolve(false));
    });
    request.once("error", () => resolve(false));
  });
}

/** Only the URL actually handed to a local GUI gets the grant; status and logs keep the normal URL. */
export async function localFileLaunchUrl(url, platform = process.platform, env = process.env, agentDir = resolve((env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")).replace(/^~(?=$|[\\/])/, homedir()))) {
  if (!localFilePlatform(platform, env)) return url;
  try {
    const target = new URL(url);
    const token = target.hash.slice(1);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password || target.pathname !== "/" || target.search || !tokenPattern.test(token)) return url;
    const key = await localFileKey(agentDir);
    if (!key) return url;
    // A new launcher can reconnect to an older runtime. Only use the extended
    // fragment after the running bridge confirms that it accepts this grant.
    const grant = makeGrant(key, token);
    if (!await acceptsGrant(target, token, grant, platform)) return url;
    target.hash = `${token}.${grant}`;
    return target.href;
  } catch { return url; }
}
