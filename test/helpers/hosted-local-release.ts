import { gunzipSync, gzipSync } from "node:zlib";
/** A second local test release of identical payload, NOT a published upstream version. */
export function localRelease(bytes: Buffer, version: string) {
  const archive = gunzipSync(bytes), parts: Buffer[] = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = Buffer.from(archive.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const size = parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/, "").trim(), 8);
    let data = archive.subarray(offset + 512, offset + 512 + size);
    if (name === "package/package.json") data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), version }));
    header.fill(0, 124, 136); header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

