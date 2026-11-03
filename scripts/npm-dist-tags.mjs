import { execFileSync } from "node:child_process";
import { npmCommand } from "../bin/npm-command.mjs";

/** Read the registry's current dist-tags; npm shims differ on Windows, so call npm-cli.js directly. */
export function fetchDistTags(name) {
  const npm = npmCommand(["view", name, "dist-tags", "--json", "--prefer-online"]);
  const result = JSON.parse(execFileSync(npm.file, npm.args, { encoding: "utf8" }));
  return Array.isArray(result) && result.length === 1 ? result[0] : result;
}
