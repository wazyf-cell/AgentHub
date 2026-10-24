import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { askBtw, listBtw, promoteBtw } from "./btw.ts";
import { createRoomFromInput } from "./create-room.ts";
import { RoomStore } from "./store.ts";
import type { AgentBackend } from "./types.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-btw-"));
  const store = new RoomStore(join(root, "data"));
  const room = createRoomFromInput(store, {
    name: "侧问房间",
    noWorkspace: true,
    defaultBinding: { platformId: "fake", modelId: "fake-planner" },
  });
  return { root, store, room };
}

const backend: AgentBackend = {
  id: "btw-test",
  async runTurn(request) {
    assert.equal(request.writeMode, false);
    return { text: `回答：${request.prompt.includes("为什么") ? "因为上下文" : "好"}`, status: "completed", costYuan: 0.05 };
  },
};

test("btw records answers, lists them and promotes to a user message", async () => {
  const { root, store, room } = setup();
  try {
    const record = await askBtw({ store, room, backend, question: "为什么？" });
    assert.equal(record.status, "completed");
    assert.match(record.answer, /因为上下文/);
    const listed = listBtw(store, room.id);
    assert.equal(listed.length, 1);

    const promoted = promoteBtw(store, room.id, record.id);
    assert.ok(promoted.messageId);
    assert.equal(promoteBtw(store, room.id, record.id).messageId, promoted.messageId, "promotion is idempotent");
    assert.equal(listBtw(store, room.id).length, 1, "promotion does not duplicate the record");
    const events = store.readEvents(room.id);
    const message = events.find((event) => event.type === "user_message");
    assert.ok(message && message.type === "user_message" && message.text.includes("[btw]"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("btw caps a room at twenty questions", async () => {
  const { root, store, room } = setup();
  try {
    for (let index = 0; index < 20; index += 1) {
      await askBtw({ store, room, backend, question: `问题 ${index}` });
    }
    await assert.rejects(() => askBtw({ store, room, backend, question: "第 21 个" }), /上限/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
