import assert from "node:assert/strict";
import test from "node:test";
import { layoutGitGraph } from "../src/plugins/builtin/git/client/git-graph.ts";

test("Git graph draws each merge parent and rejoins shared ancestors without duplicate lanes", () => {
  const graph = layoutGitGraph([
    { hash: "merge", parents: ["main", "feature"] }, { hash: "feature", parents: ["base"] },
    { hash: "main", parents: ["base"] }, { hash: "base", parents: [] },
  ]);
  assert.deepEqual(graph.rows[0]!.parents.map(edge => edge.hash), ["main", "feature"]);
  assert.equal(graph.rows[1]!.lane, 1);
  assert.equal(graph.rows[2]!.lane, 0);
  assert.equal(graph.rows[3]!.lane, 0);
  assert.equal(graph.rows[3]!.incoming, true);
  assert.deepEqual(graph.rows[3]!.parents, []);
  for (const row of graph.rows) {
    assert.equal(new Set(row.parents.map(edge => edge.hash)).size, row.parents.length);
    for (const edge of [...row.rails, ...row.parents]) assert.ok(edge.to >= 0);
  }
});

test("Git graph keeps pagination-boundary parents and starts disconnected roots without fabricated edges", () => {
  const partial = layoutGitGraph([{ hash: "a", parents: ["b", "c", "d"] }]);
  assert.equal(partial.rows[0]!.parents.length, 3); assert.equal(partial.rows[0]!.incoming, false);
  const complete = layoutGitGraph([{ hash: "a", parents: ["b", "c", "d"] }, { hash: "b", parents: [] }, { hash: "c", parents: [] }, { hash: "d", parents: [] }, { hash: "orphan", parents: [] }]);
  assert.deepEqual(complete.rows[0], partial.rows[0]);
  assert.equal(complete.rows[4]!.incoming, false); assert.deepEqual(complete.rows[4]!.rails, []);
  assert.deepEqual(layoutGitGraph([]).rows, []);
});

test("every graph edge remains connected to its actual parent across lane shifts and nested merges", () => {
  const commits = Array.from({ length: 60 }, (_, index) => ({ hash: String(index), parents: [...new Set([index + 1, ...(index % 5 === 0 ? [index + 2, index + 4] : []), ...(index % 7 === 0 ? [index + 3] : [])])].filter(parent => parent < 60).map(String) }));
  const graph = layoutGitGraph(commits);
  for (const [index, row] of graph.rows.entries()) {
    assert.deepEqual(row.parents.map(edge => edge.hash), commits[index]!.parents);
    for (const edge of row.parents) {
      let lane = edge.to;
      const target = commits.findIndex(commit => commit.hash === edge.hash);
      for (let next = index + 1; next <= target; next++) {
        const nextRow = graph.rows[next]!;
        if (next === target) { assert.equal(lane, nextRow.lane); assert.equal(nextRow.incoming, true); }
        else { const rail = nextRow.rails.find(rail => rail.from === lane); assert.ok(rail, `edge ${index} -> ${target} lost at row ${next}`); lane = rail.to; }
      }
    }
  }
});
