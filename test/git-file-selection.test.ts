import assert from "node:assert/strict";
import test from "node:test";
import { reconcileGitSelection } from "../src/plugins/builtin/git/client/git-file-selection.ts";
import type { GitFileChange } from "../src/plugins/builtin/git/contract/workspace-git.ts";
const file = (values: Partial<GitFileChange> = {}): GitFileChange => ({ path: "file.txt", index: ".", worktree: "M", untracked: false, conflict: false, submodule: false, ...values });
test("file preview preserves explicit staged/working selection without auto-selecting a file", () => {
  const entries = [file({ index: "M" })];
  assert.equal(reconcileGitSelection(null, entries), null);
  const selection = { path: "file.txt", area: "staged" as const };
  assert.equal(reconcileGitSelection(selection, entries), selection);
  assert.deepEqual(reconcileGitSelection({ ...selection, area: "unstaged" }, entries), { path: "file.txt", area: "unstaged" });
});
test("file preview follows staging/unstaging and clears when the selected path disappears", () => {
  assert.deepEqual(reconcileGitSelection({ path: "file.txt", area: "untracked" }, [file({ index: "A", worktree: "." })]), { path: "file.txt", area: "staged" });
  assert.deepEqual(reconcileGitSelection({ path: "file.txt", area: "staged" }, [file()]), { path: "file.txt", area: "unstaged" });
  assert.deepEqual(reconcileGitSelection({ path: "file.txt", area: "staged" }, [file({ untracked: true, index: "?", worktree: "?" })]), { path: "file.txt", area: "untracked" });
  assert.equal(reconcileGitSelection({ path: "gone", area: "staged" }, [file()]), null);
  assert.deepEqual(reconcileGitSelection({ path: "file.txt", area: "staged" }, [file({ conflict: true, index: "U", worktree: "U" })]), { path: "file.txt", area: "unstaged" });
});
