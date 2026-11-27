import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const BLOCK_SIZE = 64 * 1024;
const BYTE_LIMIT = 4 * 1024 * 1024;
const LF = 0x0a;

function parseArgs(args) {
  let tail;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--follow") follow = true;
    else if (arg === "--tail" || arg.startsWith("--tail=")) {
      if (tail !== undefined) throw new Error("--tail can only be specified once");
      const value = arg === "--tail" ? args[++i] : arg.slice("--tail=".length);
      if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("--tail requires a non-negative integer");
      }
      tail = Number(value);
    } else throw new Error(`Unknown logs option: ${arg}`);
  }
  return { tail: tail ?? 100, follow };
}

function redact(text) {
  return text
    .replace(/(\/#)[^\s"'<>\\)\]},]+/g, "$1[REDACTED]")
    .replace(/(\b(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token)[ \t]+)?|\bbearer[ \t]+)[A-Za-z0-9._~+/%=-]+/gi, "$1[REDACTED]")
    .replace(/(\b(?:PI_WEBAPP_RESTART_TOKEN|(?:x[-_])?(?:pi[-_]?web[-_]?(?:app[-_]?)?)?(?:auth[-_]?|access[-_]?)?token)["']?[ \t]*[:=][ \t]*["']?)[A-Za-z0-9._~+/%=-]+/gi, "$1[REDACTED]");
}

async function print(bytes) {
  if (!bytes.length) return;
  await new Promise((resolve, reject) => {
    process.stdout.write(redact(bytes.toString("utf8")), error => error ? reject(error) : resolve());
  });
}

async function readTail(file, size, lines, follow) {
  const empty = Buffer.alloc(0);
  if (!lines) {
    // An append may finish a line that --tail 0 explicitly excluded.
    if (!follow || !size) return { bytes: empty, discard: false };
    const last = Buffer.alloc(1);
    const { bytesRead } = await file.read(last, 0, 1, size - 1);
    return { bytes: empty, discard: bytesRead === 1 && last[0] !== LF };
  }

  const floor = Math.max(0, size - BYTE_LIMIT);
  const chunks = [];
  let end = size;
  while (end > floor) {
    const start = Math.max(floor, end - BLOCK_SIZE);
    const chunk = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
    if (bytesRead !== chunk.length) throw new Error("Launcher log changed while reading; please retry");
    // Ignore the final LF: it terminates a line, rather than starting an empty one.
    let index = chunk.length - (end === size ? 2 : 1);
    while (index >= 0) {
      const newline = chunk.lastIndexOf(LF, index);
      if (newline < 0) break;
      if (--lines === 0) {
        chunks.push(chunk.subarray(newline + 1));
        return { bytes: Buffer.concat(chunks.reverse()), discard: false };
      }
      index = newline - 1;
    }
    chunks.push(chunk);
    end = start;
  }

  const bytes = Buffer.concat(chunks.reverse());
  if (!floor) return { bytes, discard: false };
  // Never emit a clipped first line: its credential prefix may be missing.
  console.error("Launcher log tail limited to the last 4 MiB");
  const newline = bytes.indexOf(LF);
  return newline < 0 ? { bytes: empty, discard: true } : { bytes: bytes.subarray(newline + 1), discard: false };
}

async function followLog(file, offset, { bytes, discard }) {
  let pending = [];
  let pendingSize = 0;
  const resetLine = () => {
    pending = [];
    pendingSize = 0;
    discard = false;
  };
  const accept = async (chunk) => {
    const first = chunk.indexOf(LF);
    if (first >= 0) {
      const end = chunk.lastIndexOf(LF) + 1;
      if (!discard && pendingSize + first + 1 <= BYTE_LIMIT) {
        const head = pending.length ? Buffer.concat([...pending, chunk.subarray(0, first + 1)]) : chunk.subarray(0, first + 1);
        await print(head);
      }
      await print(chunk.subarray(first + 1, end));
      resetLine();
      chunk = chunk.subarray(end);
    }
    if (!discard && chunk.length) {
      // Wait for the line to finish so split UTF-8 or credentials stay together.
      pendingSize += chunk.length;
      if (pendingSize < BYTE_LIMIT) pending.push(Buffer.from(chunk));
      else {
        resetLine();
        discard = true;
      }
    }
  };

  await accept(bytes);
  const buffer = Buffer.allocUnsafe(BLOCK_SIZE);
  for (;;) {
    const { size } = await file.stat();
    if (size < offset) {
      offset = 0;
      resetLine();
    }
    if (size > offset) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead) {
        offset += bytesRead;
        await accept(buffer.subarray(0, bytesRead));
        continue;
      }
    }
    await delay(100);
  }
}

/** Read the existing launcher log. Pass the CLI arguments after `logs`. */
export async function showLogs(logPath, args = []) {
  const { tail, follow } = parseArgs(args);
  const file = await open(logPath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Launcher log is not a regular file");
    const initial = await readTail(file, stat.size, tail, follow);
    if (follow) await followLog(file, stat.size, initial);
    else await print(initial.bytes);
  } finally {
    await file.close();
  }
}
