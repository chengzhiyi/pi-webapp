import assert from "node:assert/strict";
import test from "node:test";
import { parseGitPatch, previewGitPatch } from "../web/src/git-patch.ts";

test("unified diffs count old/new lines across hunks and keep header-looking source lines as changes", () => {
  const lines = parseGitPatch("--- a/file\n+++ b/file\n@@ -2,2 +4,2 @@\n same\n--- old\n+++ new\n\\ No newline at end of file\n@@ -20 +22 @@\n-last\n+next\n");
  assert.deepEqual(lines.filter(line => line.kind !== "meta"), [
    { kind: "context", text: " same", oldLine: 2, newLine: 4 },
    { kind: "remove", text: "--- old", oldLine: 3, newLine: null },
    { kind: "add", text: "+++ new", oldLine: null, newLine: 5 },
    { kind: "remove", text: "-last", oldLine: 20, newLine: null },
    { kind: "add", text: "+next", oldLine: null, newLine: 22 },
  ]);
});

test("preview hides Git headers, replaces hunk syntax, and groups adjacent edits rather than whole hunks", () => {
  const preview = previewGitPatch("diff --git a/file b/file\nindex 123..456 100644\n--- a/file\n+++ b/file\n@@ -2,4 +2,4 @@ function example()\n-index old\n+diff --git source code\n context\n--- old\n\\ No newline at end of file\n+++ new\n@@ -40 +40 @@\n-last\n+next\n");
  assert.deepEqual(preview.changes, [1, 4, 7]);
  assert.deepEqual(preview.lines.map(line => [line.kind, line.text, line.change]), [
    ["hunk", "function example()", null],
    ["remove", "-index old", 0], ["add", "+diff --git source code", 0],
    ["context", " context", null], ["remove", "--- old", 1], ["add", "+++ new", 1],
    ["hunk", "", null], ["remove", "-last", 2], ["add", "+next", 2],
  ]);
  assert.equal(preview.lines[4]!.noNewline, true);
  assert.equal(preview.lines[6]!.oldLine, 40);
  assert.equal(preview.lines[6]!.newLine, 40);
  assert.deepEqual(preview.notices, []);
});

test("preview keeps meaningful file-only changes and has no navigation targets for them", () => {
  const preview = previewGitPatch("diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\nold mode 100644\nnew mode 100755\n");
  assert.deepEqual(preview.lines, []);
  assert.deepEqual(preview.changes, []);
  assert.deepEqual(preview.notices, [
    { kind: "rename", from: "old", to: "new" },
    { kind: "mode", from: "100644", to: "100755" },
  ]);
  assert.deepEqual(previewGitPatch("diff --git a/empty b/empty\nnew file mode 100644\nindex 000..e69\n").notices, [{ kind: "added", from: "", to: "100644" }]);
  assert.deepEqual(previewGitPatch("diff --git a/empty b/empty\ndeleted file mode 100644\nindex e69..000\n").notices, [{ kind: "deleted", from: "100644", to: "" }]);
  assert.deepEqual(previewGitPatch(""), { lines: [], changes: [], notices: [] });
});

test("preview handles addition/deletion-only hunks, copied files, and resets groups between file patches", () => {
  const preview = previewGitPatch("diff --git a/old b/old\ndeleted file mode 100644\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/new b/new\nnew file mode 100644\n--- /dev/null\n+++ b/new\n@@ -0,0 +1,2 @@\n+new\n+second\n\\ No newline at end of file\n");
  assert.deepEqual(preview.changes, [1, 3]);
  assert.deepEqual(preview.lines.filter(line => line.change !== null).map(line => [line.oldLine, line.newLine, line.change]), [[1, null, 0], [null, 1, 1], [null, 2, 1]]);
  assert.equal(preview.lines.at(-1)!.noNewline, true);
  assert.deepEqual(preview.notices, []);
  assert.deepEqual(previewGitPatch("diff --git a/old b/copy\ncopy from old\ncopy to copy\n").notices, [{ kind: "copy", from: "old", to: "copy" }]);
});

test("multi-file patches reset metadata after a hunk and empty patches have no rows", () => {
  const lines = parseGitPatch("diff --git a/old b/old\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+new\n");
  assert.equal(lines[7]!.kind, "meta");
  assert.deepEqual(lines.at(-1), { kind: "add", text: "+new", oldLine: null, newLine: 1 });
  assert.deepEqual(parseGitPatch(""), []);
});
