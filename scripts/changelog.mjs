import assert from "node:assert/strict";

// The user-facing changelog is part of the documentation site. English is the
// source; the Chinese page mirrors it section for section. A desktop build's
// section heading ends in {#build-N}; changes not yet released sit under
// {#unreleased}.
export const docsSite = "https://pi.emath.top";
export const changelogPaths = { en: "docs/en/changelog.md", zh: "docs/zh/changelog.md" };

const isSection = line => line.startsWith("## ");
const anchorOf = line => /\{#([\w-]+)\}\s*$/.exec(line)?.[1];

/** Body of the section whose heading carries `{#anchor}`, or undefined. */
export function changelogSection(markdown, anchor) {
  const lines = markdown.split("\n");
  const start = lines.findIndex(line => isSection(line) && anchorOf(line) === anchor);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, index) => index > start && isSection(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** A desktop build's changelog section, rewritten for GitHub release notes. */
export function releaseChangelog(markdown, build) {
  const body = changelogSection(markdown, `build-${build}`);
  assert.ok(body, `${changelogPaths.en} needs a non-empty "## … {#build-${build}}" section for desktop build ${build}`);
  return body
    .replace(/^(#{3,6} .*?)[ \t]*\{#[\w-]+\}[ \t]*$/gm, "$1")
    .replace(/\]\(\.\/([^)\s]*)\)/g, `](${docsSite}/$1)`);
}

const headings = {
  en: (build, version, date) => `## Desktop build ${build} · pi ${version} · ${date} {#build-${build}}`,
  zh: (build, version, date) => `## 桌面构建 ${build} · pi ${version} · ${date} {#build-${build}}`,
};

/** Turns the Unreleased heading into the heading of desktop build `build`. Returns undefined when there is no Unreleased section. */
export function promoteUnreleased(markdown, { language, build, version, date }) {
  assert.ok(headings[language], `unknown changelog language: ${language}`);
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(changelogSection(markdown, `build-${build}`), undefined, `the changelog already has a section for desktop build ${build}`);
  const lines = markdown.split("\n");
  const index = lines.findIndex(line => isSection(line) && anchorOf(line) === "unreleased");
  if (index < 0) return undefined;
  lines[index] = headings[language](build, version, date);
  return lines.join("\n");
}
