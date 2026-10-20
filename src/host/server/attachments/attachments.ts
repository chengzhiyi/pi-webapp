import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function isWindowsDeviceName(name: string): boolean {
  const dot = name.indexOf('.');
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '');
  return WINDOWS_DEVICE_NAME.test(stem);
}

function utf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of Buffer.from(value).toString('utf8')) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}

export function fileLeafName(value: string | undefined): string {
  if (value === undefined) return 'file';
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1);
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '');
  if (isWindowsDeviceName(clean)) clean = `_${clean}`;
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '');
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

export interface UploadedAttachment {
  id: string;
  name: string;
  bytes: number;
  path: string;
  mediaType: string;
  sessionId: string;
}

function verifiedImageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function saveAttachment(sessionId: string, name: string, mediaType: string, data: Buffer): Promise<UploadedAttachment> {
  if (data.byteLength === 0 || data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('文件为空或超过 20 MB');
  const safeName = fileLeafName(name);
  const digest = createHash('sha256').update(data).digest('hex');
  const directory = join(getAgentDir(), 'pi-web', 'attachments', digest);
  await mkdir(directory, { recursive: true });
  const path = join(directory, safeName);
  try { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  return { id: randomUUID(), name: safeName, bytes: data.byteLength, path, mediaType: verifiedImageType(data) ?? mediaType.replace(/^image\//, 'application/'), sessionId };
}

export async function imageContent(attachment: UploadedAttachment): Promise<{ type: 'image'; data: string; mimeType: string }> {
  return { type: 'image', data: (await readFile(attachment.path)).toString('base64'), mimeType: attachment.mediaType };
}
