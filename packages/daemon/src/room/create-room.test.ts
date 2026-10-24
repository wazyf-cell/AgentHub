import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoomFromInput } from "./create-room.ts";
import { createDemoRoom } from "./demo.ts";
import { RoomStore } from "./store.ts";
import { addWorkspace } from "./workspaces.ts";

function withStore(run: (store: RoomStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agenthub-create-room-"));
  const store = new RoomStore(join(root, "data"));
  try {
    run(store, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a new room can clone role cards and rules from another room", () => {
  withStore((store, root) => {
    const source = createDemoRoom(store, root);
    const workspace = addWorkspace(store, { name: "Demo", path: root });
    const room = createRoomFromInput(store, {
      name: "第二个房间",
      workspaceId: workspace.id,
      copyFromRoomId: source.id,
    });

    assert.notEqual(room.id, "demo");
    assert.equal(room.name, "第二个房间");
    assert.equal(room.workspaceId, workspace.id);
    assert.equal(room.workspace, root);
    assert.deepEqual(room.members, source.members);
    assert.equal(room.rules.autonomy, source.rules.autonomy);
    assert.equal(room.rules.maxHandoffs, source.rules.maxHandoffs);
    assert.deepEqual(room.rules.planOrder, room.members.map((member) => member.id));
    assert.deepEqual(store.readEvents(room.id).map((event) => event.type), ["room_created"]);
  });
});

test("a chat-only room gets one default member and no workspace", () => {
  withStore((store) => {
    const room = createRoomFromInput(store, {
      name: "只聊天",
      noWorkspace: true,
      defaultBinding: { platformId: "codex-cli", modelId: "deepseek-v4.1-flash" },
    });
    assert.equal(room.workspace, "");
    assert.equal(room.workspaceId, undefined);
    assert.equal(room.members.length, 1);
    assert.equal(room.members[0].binding.platformId, "codex-cli");
    assert.deepEqual(room.rules.planOrder, [room.members[0].id]);
  });
});

test("room ids are generated, unique and can be explicit", () => {
  withStore((store) => {
    const first = createRoomFromInput(store, {
      name: "UI Review",
      noWorkspace: true,
      defaultBinding: { platformId: "fake", modelId: "fake-planner" },
    });
    const second = createRoomFromInput(store, {
      name: "UI Review",
      noWorkspace: true,
      defaultBinding: { platformId: "fake", modelId: "fake-planner" },
    });
    assert.equal(first.id, "ui-review");
    assert.equal(second.id, "ui-review-2");

    const explicit = createRoomFromInput(store, {
      id: "custom-room",
      name: "自定义",
      noWorkspace: true,
      defaultBinding: { platformId: "fake", modelId: "fake-planner" },
    });
    assert.equal(explicit.id, "custom-room");
    assert.throws(() => createRoomFromInput(store, {
      id: "custom-room",
      name: "重复",
      noWorkspace: true,
      defaultBinding: { platformId: "fake", modelId: "fake-planner" },
    }), /already exists/);
  });
});

test("invalid room input is rejected", () => {
  withStore((store, root) => {
    assert.throws(() => createRoomFromInput(store, { name: "  ", noWorkspace: true }), /name is required/);
    assert.throws(() => createRoomFromInput(store, { name: "无归属" }), /workspace/);
    assert.throws(() => createRoomFromInput(store, {
      name: "坏工作区",
      workspaceId: "missing",
    }), /Workspace not found/);
    assert.throws(() => createRoomFromInput(store, {
      name: "坏目录",
      workspacePath: join(root, "missing-folder"),
    }), /does not exist/);
  });
});
