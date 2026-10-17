import assert from "node:assert/strict";
import test from "node:test";
import { workspacePreviewPath } from "../web/src/ui/workspace-path.ts";
import { parseFileLink } from "../web/src/ui/shared/primitives/markdown/file-link.ts";

test("Chinese Markdown destinations decode once and share a workspace preview identity", () => {
  const path = "docs/协作内核与插件协议设计.md";
  const link = parseFileLink(`docs/${encodeURIComponent("协作内核与插件协议设计.md")}`)!;
  assert.equal(link.path, path);
  for (const value of [path, `./${path}`, `/project/${path}`, `docs/../${path}`]) {
    assert.equal(workspacePreviewPath("/project", value), path);
  }
  assert.equal(parseFileLink("docs/a%2520b.md")?.path, "docs/a%20b.md");
  assert.deepEqual(parseFileLink("docs/a%23b.md#L4"), { path: "docs/a#b.md", line: 4 });
});

test("outside paths retain their boundary for the server to reject, and external URLs remain external", () => {
  for (const path of ["../secret.txt", "/project-other/secret.txt", "/secret.txt"]) {
    assert.equal(workspacePreviewPath("/project", path), path);
  }
  assert.equal(workspacePreviewPath("C:\\Project", "c:\\project\\docs\\readme.md"), "docs/readme.md");
  for (const href of ["https://example.com/guide.md", "mailto:hello@example.com", "javascript:alert(1)", "//example.com/file.md", "#section", "docs/%zz.md"]) {
    assert.equal(parseFileLink(href), undefined);
  }
});
