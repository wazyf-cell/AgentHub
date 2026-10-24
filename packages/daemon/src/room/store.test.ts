import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoRoom } from "./demo.ts";
import { RoomStore } from "./store.ts";

test("rooms can be created, listed, read and exported", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-room-store-"));
  const exportDir = mkdtempSync(join(tmpdir(), "agenthub-room-export-"));
  rmSync(exportDir, { recursive: true, force: true });
  const store = new RoomStore(dataDir);

  try {
    const room = createDemoRoom(store, process.cwd());
    assert.equal(room.id, "demo");
    assert.equal(store.hasRoom("demo"), true);
    assert.equal(store.listRooms().length, 1);
    assert.equal(store.readRoom("demo").members.length, 3);

    const event = store.appendEvent("demo", { type: "error", message: "probe" });
    assert.equal(event.roomId, "demo");
    assert.equal(event.v, 1);
    assert.ok(store.readEvents("demo").some((item) => item.type === "error"));

    store.exportRoom("demo", exportDir);
    assert.equal(existsSync(join(exportDir, "room.json")), true);
    assert.equal(existsSync(join(exportDir, "events.jsonl")), true);

    assert.throws(() => store.createRoom(room), /already exists/);
    assert.throws(() => store.roomDir("../escape"), /Invalid room id/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  }
});

test("a corrupt event line is reported with its line number", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-room-corrupt-"));
  const store = new RoomStore(dataDir);

  try {
    createDemoRoom(store, process.cwd());
    appendFileSync(join(store.roomDir("demo"), "events.jsonl"), "{not json}\n", "utf8");
    assert.throws(() => store.readEvents("demo"), /Invalid room event at .*:2/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("missing rooms produce a clear error", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-room-missing-"));
  const store = new RoomStore(dataDir);
  try {
    assert.equal(store.hasRoom("nope"), false);
    assert.deepEqual(store.listRooms(), []);
    assert.throws(() => store.readRoom("nope"), /not found/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
