export interface GraphEdge { from: number; to: number; color: number }
export interface GitGraphRow {
  lane: number;
  color: number;
  incoming: boolean;
  rails: GraphEdge[];
  parents: (GraphEdge & { hash: string })[];
}

/** Topological input keeps every parent below its children, including parents on a later page. */
export function layoutGitGraph(commits: readonly { hash: string; parents: readonly string[] }[]) {
  let lanes: { hash: string; color: number }[] = [];
  let nextColor = 0, width = 1;
  const rows: GitGraphRow[] = [];
  for (const commit of commits) {
    const existing = lanes.findIndex(lane => lane.hash === commit.hash);
    const lane = existing < 0 ? lanes.length : existing;
    const color = existing < 0 ? nextColor++ % 4 : lanes[lane]!.color;
    const before = [...lanes];
    if (existing >= 0) lanes.splice(existing, 1);
    let insert = Math.min(lane, lanes.length);
    const parents = [...new Set(commit.parents)];
    for (const [index, hash] of parents.entries()) if (!lanes.some(lane => lane.hash === hash)) {
      lanes.splice(insert++, 0, { hash, color: index === 0 ? color : nextColor++ % 4 });
    }
    rows.push({ lane, color, incoming: existing >= 0,
      rails: before.flatMap((item, from) => item.hash === commit.hash ? [] : [{ from, to: lanes.findIndex(lane => lane.hash === item.hash), color: item.color }]),
      parents: parents.map(hash => { const to = lanes.findIndex(lane => lane.hash === hash); return { hash, from: lane, to, color: lanes[to]!.color }; }),
    });
    width = Math.max(width, lane + 1, before.length, lanes.length);
  }
  return { rows, width: width * 16 + 16 };
}
