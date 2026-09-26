import assert from "node:assert/strict";
import test from "node:test";
import { directoryPickerKind, pickNativeDirectory } from "../extension/native-directory-picker.ts";

test("uses the native chooser for an attended local macOS launch", () => {
  assert.equal(directoryPickerKind("darwin", {}), "native");
  assert.equal(directoryPickerKind("darwin", { SSH_CONNECTION: "remote" }), "browse");
  assert.equal(directoryPickerKind("linux", { DISPLAY: ":0", PATH: "" }), "browse");
});

test("the macOS native picker returns a selected folder and treats cancellation as no selection", async () => {
  const commands: string[] = [];
  const selected = await pickNativeDirectory(new AbortController().signal, "darwin", async (command, args) => {
    commands.push(`${command}:${args.join(" ")}`);
    return { stdout: "/Users/example/project/\n", stderr: "" };
  });
  assert.equal(selected, "/Users/example/project/");
  assert.match(commands[0]!, /^osascript:/);
  const cancelled = await pickNativeDirectory(new AbortController().signal, "darwin", async () => {
    throw Object.assign(new Error("cancelled"), { code: 1, stderr: "User canceled. (-128)" });
  });
  assert.equal(cancelled, null);
});
