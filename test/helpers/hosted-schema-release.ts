import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Explicit synthetic local release, NEVER a remote/upstream model or published plugin.
 * Keep the real editor/store/worker and add one required field to diagram_read so a stale
 * schema is observably invalid on the new worker. Resource verification stays fully active.
 */
export async function schemaRelease(root: string, archive: string) {
  const folder = join(root, "schema-fixture"); await mkdir(folder);
  await promisify(execFile)("tar", ["-xzf", archive, "-C", folder]);
  const pkgRoot = join(folder, "package"), manifestPath = join(pkgRoot, "package.json");
  const pkg = JSON.parse(await readFile(manifestPath, "utf8")); pkg.version = "0.1.1";
  await writeFile(manifestPath, JSON.stringify(pkg));
  await rename(join(pkgRoot, "dist/runtime.js"), join(pkgRoot, "dist/original-runtime.js"));
  const wrapper = `import { createRuntime as original } from "./original-runtime.js";
export const createRuntime = ctx => {
  const runtime = original(ctx);
  return { ...runtime,
    describe: () => ({ tools: runtime.describe().tools.map(tool => tool.name !== "diagram_read" ? tool : ({ ...tool, description: "ORI-39 SYNTHETIC schema 2", parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, ori39Schema: { type: "number", const: 2 } }, required: [...(tool.parameters.required ?? []), "ori39Schema"] } })) }),
    invoke(request) { if (request.kind === "tool" && request.action === "read" && request.input.ori39Schema !== 2) throw new Error("ORI-39 synthetic new worker requires schema 2"); return runtime.invoke(request); }
  };
};\n`;
  await writeFile(join(pkgRoot, "dist/runtime.js"), wrapper);
  const resourcesPath = join(pkgRoot, "dist/resources.json"), resources = JSON.parse(await readFile(resourcesPath, "utf8"));
  for (const path of ["./dist/runtime.js", "./dist/original-runtime.js"]) {
    const bytes = await readFile(join(pkgRoot, path));
    const entry = { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mime: "text/javascript" };
    const index = resources.files.findIndex((file: any) => file.path === path);
    if (index < 0) resources.files.push(entry); else resources.files[index] = entry;
  }
  await writeFile(resourcesPath, JSON.stringify(resources));
  const output = join(root, "ori39-SYNTHETIC-schema-2.tgz");
  await promisify(execFile)("tar", ["--format", "ustar", "--no-xattrs", "-czf", output, "-C", folder, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return readFile(output);
}
