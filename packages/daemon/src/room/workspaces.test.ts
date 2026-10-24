import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoomFromInput } from "./create-room.ts";
import { createDemoRoom } from "./demo.ts";
import { RoomStore } from "./store.ts";
import {
  addWorkspace,
  listWorkspaceSummaries,
  removeWorkspace,
  renameWorkspace,
  syncWorkspacesFromRooms,
} from "./workspaces.ts";

function withStore(run: (store: RoomStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agenthub-workspaces-"));
  const store = new RoomStore(join(root, "data"));
  try {
    run(store, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("workspaces enforce unique names and paths", () => {
  withStore((store, root) => {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);

    const workspace = addWorkspace(store, { name: "项目 A", path: first });
    assert.equal(workspace.name, "项目 A");
    assert.equal(workspace.path, first);

    assert.throws(() => addWorkspace(store, { name: "别的名字", path: first }), /already registered/);
    assert.throws(() => addWorkspace(store, { name: "项目 A", path: second }), /name already exists/);
    assert.throws(() => addWorkspace(store, { name: "项目 B", path: join(root, "missing") }), /does not exist/);

    const other = join(root, "third");
    mkdirSync(other);
    addWorkspace(store, { name: "项目 C", path: other });

    const renamed = renameWorkspace(store, workspace.id, "项目 B");
    assert.equal(renamed.name, "项目 B");
    assert.throws(() => renameWorkspace(store, workspace.id, "项目 c"), /name already exists/);

    const summaries = listWorkspaceSummaries(store);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].available, true);
    assert.equal(summaries[0].roomCount, 0);
  });
});

test("removing a workspace only forgets it and refuses referenced rooms", () => {
  withStore((store, root) => {
    const folder = join(root, "repo");
    mkdirSync(folder);
    const workspace = addWorkspace(store, { name: "Repo", path: folder });
    const room = createRoomFromInput(store, {
      name: "任务房间",
      workspaceId: workspace.id,
      defaultBinding: { platformId: "fake", modelId: "fake-planner" },
    });

    assert.throws(() => removeWorkspace(store, workspace.id), new RegExp(room.name));
    assert.equal(listWorkspaceSummaries(store)[0].roomCount, 1);

    const sparePath = join(root, "spare");
    mkdirSync(sparePath);
    const spare = addWorkspace(store, { name: "Spare", path: sparePath });
    removeWorkspace(store, spare.id);
    assert.deepEqual(listWorkspaceSummaries(store).map((item) => item.id), [workspace.id]);
  });
});

test("existing rooms are registered once by path", () => {
  withStore((store, root) => {
    createDemoRoom(store, root);
    const registered = syncWorkspacesFromRooms(store);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].path, root);
    assert.equal(store.readRoom("demo").workspaceId, registered[0].id);

    createRoomFromInput(store, {
      name: "同一目录",
      workspaceId: registered[0].id,
      copyFromRoomId: "demo",
    });
    assert.equal(listWorkspaceSummaries(store).length, 1);
    assert.equal(listWorkspaceSummaries(store)[0].roomCount, 2);
  });
});
