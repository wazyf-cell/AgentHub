import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoomFromInput } from "./create-room.ts";
import {
  BUILTIN_MEMBERS,
  MEMBER_CATEGORIES,
  createLibraryMember,
  libraryFilePath,
  loadMemberLibrary,
  removeLibraryMember,
  restoreLibraryMember,
  updateLibraryMember,
} from "./member-library.ts";
import { RoomStore } from "./store.ts";

function withStore(run: (store: RoomStore, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agenthub-member-library-"));
  const store = new RoomStore(join(root, "data"));
  try {
    run(store, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("member library seeds 12 built-in roles across six categories", () => {
  withStore((store) => {
    const members = loadMemberLibrary(store);
    assert.equal(members.length, 12);
    assert.equal(BUILTIN_MEMBERS.length, 12);
    assert.ok(members.every((member) => member.builtin));
    assert.ok(members.every((member) => member.instructions.trim().length > 20));
    const categories = new Set(members.map((member) => member.category));
    assert.equal(categories.size, 6);
    for (const category of categories) {
      assert.ok((MEMBER_CATEGORIES as readonly string[]).includes(category));
      assert.equal(members.filter((member) => member.category === category).length, 2);
    }
  });
});

test("custom members can be created, edited, hidden and removed", () => {
  withStore((store) => {
    const created = createLibraryMember(store, {
      name: "性能优化师",
      role: "性能",
      category: "工程与架构",
      avatar: "⚡",
      description: "定位卡顿与内存问题",
      instructions: "先测量再优化，给出基线、瓶颈和回归数据。",
      tags: ["性能", "性能"],
    });
    assert.equal(created.builtin, false);
    assert.match(created.id, /^member-/);
    assert.deepEqual(created.tags, ["性能"]);

    const updated = updateLibraryMember(store, created.id, {
      name: "性能工程师",
      hidden: true,
    });
    assert.equal(updated.name, "性能工程师");
    assert.equal(updated.hidden, true);
    assert.equal(loadMemberLibrary(store).find((member) => member.id === created.id)?.name, "性能工程师");

    removeLibraryMember(store, created.id);
    assert.equal(loadMemberLibrary(store).some((member) => member.id === created.id), false);
  });
});

test("built-in members can be edited and restored but not removed", () => {
  withStore((store) => {
    const original = loadMemberLibrary(store).find((member) => member.id === "architect");
    assert.ok(original);
    const edited = updateLibraryMember(store, "architect", {
      name: "系统架构师",
      instructions: "先给约束，再给方案。",
    });
    assert.equal(edited.edited, true);
    assert.equal(edited.name, "系统架构师");

    assert.throws(() => removeLibraryMember(store, "architect"), /内置成员不能删除/);

    const restored = restoreLibraryMember(store, "architect");
    assert.equal(restored.name, original.name);
    assert.equal(restored.instructions, original.instructions);
    assert.equal(restored.edited, undefined);
  });
});

test("a corrupted library file is backed up and re-seeded", () => {
  withStore((store) => {
    loadMemberLibrary(store);
    writeFileSync(libraryFilePath(store), "{ not json", "utf8");
    const members = loadMemberLibrary(store);
    assert.equal(members.length, 12);
    assert.ok(members.every((member) => member.builtin));
  });
});

test("creating a room from library members copies roles and keeps library edits isolated", () => {
  withStore((store) => {
    const room = createRoomFromInput(store, {
      name: "架构评审房间",
      noWorkspace: true,
      libraryMemberIds: ["architect", "code-reviewer", "qa-engineer"],
      defaultBinding: { platformId: "codex-cli", modelId: "deepseek-v4.1-flash" },
    });
    assert.equal(room.members.length, 3);
    assert.deepEqual(room.members.map((member) => member.id), ["architect", "code-reviewer", "qa-engineer"]);
    assert.equal(room.members[0].sourceMemberId, "architect");
    assert.equal(room.members[0].binding.platformId, "codex-cli");
    assert.equal(room.members[0].permissions?.write, false);
    assert.deepEqual(room.rules.planOrder, room.members.map((member) => member.id));

    updateLibraryMember(store, "architect", { name: "改名了" });
    assert.equal(store.readRoom(room.id).members[0].name, "架构师");
  });
});

test("unknown library member ids fail room creation without writing a room", () => {
  withStore((store) => {
    assert.throws(
      () => createRoomFromInput(store, { name: "坏房间", noWorkspace: true, libraryMemberIds: ["missing"] }),
      /找不到 "missing"/,
    );
    assert.deepEqual(store.listRooms(), []);
  });
});

test("unedited built-ins follow preset updates while edited built-ins keep user changes", () => {
  withStore((store) => {
    const members = loadMemberLibrary(store);
    const architect = members.find((member) => member.id === "architect");
    assert.ok(architect);
    architect.role = "旧角色";
    architect.edited = false;
    const reviewer = members.find((member) => member.id === "code-reviewer");
    assert.ok(reviewer);
    reviewer.role = "手工角色";
    reviewer.edited = true;
    writeFileSync(libraryFilePath(store), `${JSON.stringify({ version: 1, members }, null, 2)}\n`, "utf8");
    const reloaded = loadMemberLibrary(store);
    assert.equal(reloaded.find((member) => member.id === "architect")?.role, "架构");
    assert.equal(reloaded.find((member) => member.id === "code-reviewer")?.role, "手工角色");
  });
});
