import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HostedPluginError } from "./errors.ts";
import { RESOURCE_LIMITS } from "./resources.ts";

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = RESOURCE_LIMITS.total + RESOURCE_LIMITS.files * 2048;
const invalid = (message: string): never => { throw new HostedPluginError("invalid_archive", message); };
function text(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end)); }
  catch { return invalid("Archive has invalid UTF-8 paths"); }
}
function octal(bytes: Buffer): number {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) return invalid("Unsupported archive number encoding");
  const n = parseInt(value, 8);
  if (!Number.isSafeInteger(n)) return invalid("Archive number exceeds limits");
  return n;
}
function memberPath(value: string): string {
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  if (path === "package") return "";
  if (!path.startsWith("package/") || path.length > 1024) return invalid("Archive must have one package root");
  const relative = path.slice(8);
  if (relative.split("/").some(p => !p || p === "." || p === ".." || !/^[A-Za-z0-9_@.-]+$/.test(p))) return invalid("Archive path is not a safe relative package path");
  return relative;
}
function pax(bytes: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) return invalid("Invalid PAX header");
    const prefix = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d{0,5}$/.test(prefix)) return invalid("Invalid PAX record length");
    const length = Number(prefix), end = offset + length;
    if (end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) return invalid("Truncated PAX record");
    const record = text(bytes.subarray(space + 1, end - 1)), equals = record.indexOf("=");
    if (equals < 1) return invalid("Invalid PAX record");
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (Object.hasOwn(fields, key) || !["path", "size", "mtime", "atime", "ctime", "uid", "gid", "uname", "gname", "comment"].includes(key)) return invalid("Unsupported PAX feature");
    fields[key] = value; offset = end;
  }
  return fields;
}
/** Parse everything BEFORE writing. No tar executable, install scripts, links or sparse files. */
export function archiveMembers(archive: Buffer): Array<{ path: string; data: Buffer; directory: boolean }> {
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES) return invalid("Compressed archive exceeds budget");
  let bytes: Buffer;
  try { bytes = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { return invalid("Invalid or oversized gzip archive"); }
  const members: Array<{ path: string; data: Buffer; directory: boolean }> = [], seen = new Set<string>();
  let offset = 0, total = 0, unpacked = 0, headers = 0, extended: Record<string, string> | null = null, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) {
      if (extended || bytes.subarray(offset).some(b => b !== 0)) return invalid("Unexpected archive data after end marker");
      ended = true; break;
    }
    if (++headers > RESOURCE_LIMITS.files * 2) return invalid("Too many archive headers");
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (octal(header.subarray(148, 156)) !== checksum) return invalid("Invalid tar header checksum");
    const magic = text(header.subarray(257, 263));
    if (magic && magic !== "ustar" && magic !== "ustar ") return invalid("Unsupported tar format");
    const type = header[156], prefix = text(header.subarray(345, 500));
    let path = (prefix ? prefix + "/" : "") + text(header.subarray(0, 100));
    let size = octal(header.subarray(124, 136));
    if (extended) {
      if (extended.path !== undefined) path = extended.path;
      if (extended.size !== undefined) {
        if (!/^(0|[1-9]\d*)$/.test(extended.size)) return invalid("Invalid PAX size");
        size = Number(extended.size);
      }
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > RESOURCE_LIMITS.total || offset + size > bytes.length) return invalid("Truncated or oversized tar member");
    const data = bytes.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === 120) {
      if (extended || size > 8192) return invalid("Oversized or chained PAX header");
      extended = pax(data); continue;
    }
    extended = null;
    if (type !== 0 && type !== 48 && type !== 53) return invalid("Links and special archive members are forbidden");
    const directory = type === 53;
    if (directory && size !== 0 || text(header.subarray(157, 257))) return invalid("Invalid archive link or directory");
    path = memberPath(path);
    if (!path && !directory) return invalid("Invalid package root member");
    if (seen.has(path)) return invalid("Duplicate archive member");
    seen.add(path);
    if (++total > RESOURCE_LIMITS.files || (unpacked += size) > RESOURCE_LIMITS.total) return invalid("Unpacked archive exceeds budget");
    members.push({ path, data, directory });
  }
  if (!ended || !seen.has("package.json")) return invalid("Archive is incomplete or has no package.json");
  // A file must never also act as an ancestor directory, independent of member ordering.
  const files = new Set(members.filter(m => !m.directory).map(m => m.path));
  for (const m of members) {
    const parts = m.path.split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join("/"))) return invalid("Archive file/directory collision");
  }
  return members;
}
/** Destination must be a newly-created private directory with no untrusted writers. */
export async function extractHostedArchive(archive: Buffer, destination: string): Promise<void> {
  const members = archiveMembers(archive);
  for (const member of members) {
    if (!member.path) continue;
    const path = join(destination, member.path);
    await mkdir(member.directory ? path : dirname(path), { recursive: true, mode: 0o700 });
    if (!member.directory) await writeFile(path, member.data, { flag: "wx", mode: 0o600 });
  }
}
