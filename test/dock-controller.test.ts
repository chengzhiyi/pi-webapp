import assert from "node:assert/strict";
import test from "node:test";
import { DockController } from "../web/src/ui/shared/dockkit/engine/controller.ts";
import { dockPaneIds, getPane } from "../web/src/ui/shared/dockkit/engine/tree.ts";
import type { TabId } from "../web/src/ui/shared/dockkit/contract/types.ts";

const guide = (id: TabId) => ({ id, kind: "guide", contentId: "guide", title: "Start" });
const createController = () => new DockController({ makeInitialTab: guide, makePaneTab: guide });

for (const side of [0, 1]) test(`closing the last tab in split pane ${side} publishes only the merged layout`, () => {
  const controller = createController();
  controller.setExpanded(true);
  controller.splitPane();
  const before = controller.getSnapshot().state;
  const panes = dockPaneIds(before);
  const closedTab = getPane(before, panes[side]!).tabs[0]!;
  const survivor = getPane(before, panes[1 - side]!);
  let notifications = 0;
  controller.subscribe(() => {
    notifications++;
    const state = controller.getSnapshot().state;
    assert.equal(dockPaneIds(state).length, 1);
    assert.ok(getPane(state, dockPaneIds(state)[0]!).tabs.length);
  });
  controller.closeTab(closedTab);
  assert.equal(notifications, 1);
  const after = controller.getSnapshot().state;
  assert.equal(after.rootId, survivor.id);
  assert.deepEqual(getPane(after, survivor.id).tabs, survivor.tabs);
  assert.equal(after.activePaneId, survivor.id);
});

test("closing and merging a pane undo and redo together", () => {
  const controller = createController();
  controller.splitPane();
  const before = controller.getSnapshot().state;
  controller.closeTab(getPane(before, dockPaneIds(before)[0]!).tabs[0]!);
  const after = controller.getSnapshot().state;
  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.getSnapshot().state, before);
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.getSnapshot().state, after);
});

for (const gesture of ["place", "drop", "float"] as const) test(`${gesture} of a pane's last tab removes its empty source pane`, () => {
  const controller = createController();
  controller.splitPane();
  const before = controller.getSnapshot().state;
  const [source, target] = dockPaneIds(before);
  const tab = getPane(before, source!).tabs[0]!;
  if (gesture === "place") controller.placeTab(tab, target!, 0);
  else if (gesture === "drop") controller.dropTab(tab, target!, "center");
  else controller.floatTab(tab);
  const after = controller.getSnapshot().state;
  assert.deepEqual(dockPaneIds(after), [target]);
  assert.ok(getPane(after, target!).tabs.length);
  assert.ok(after.tabs[tab]);
  controller.undo();
  assert.deepEqual(controller.getSnapshot().state, before);
});

test("closing all tabs leaves one empty root that can reopen without an empty split", () => {
  const controller = createController();
  controller.splitPane();
  for (const tab of Object.values(controller.getSnapshot().state.tabs)) controller.closeTab(tab.id);
  const empty = controller.getSnapshot().state;
  assert.equal(dockPaneIds(empty).length, 1);
  assert.equal(Object.keys(empty.tabs).length, 0);
  controller.addTab(controller.activeDockPaneId());
  const reopened = controller.getSnapshot().state;
  assert.equal(dockPaneIds(reopened).length, 1);
  assert.equal(Object.values(reopened.tabs)[0]?.kind, "guide");
});

test("floating the only root tab leaves a usable guide in the dock", () => {
  const controller = createController();
  const before = controller.getSnapshot().state;
  controller.floatTab(Object.values(before.tabs)[0]!.id);
  const after = controller.getSnapshot().state;
  const root = getPane(after, dockPaneIds(after)[0]!);
  assert.equal(root.tabs.length, 1);
  assert.equal(after.tabs[root.tabs[0]!]!.kind, "guide");
  assert.equal(after.floats.length, 1);
});
