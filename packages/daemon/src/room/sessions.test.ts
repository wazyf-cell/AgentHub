import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoRoom } from "./demo.ts";
import { SessionStore } from "./sessions.ts";
import { RoomStore } from "./store.ts";

test("sessions are scoped to one platform and model", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-sessions-"));
  const store = new RoomStore(dataDir);
  try {
    createDemoRoom(store, process.cwd());
    const sessions = new SessionStore(store, "demo");
    assert.equal(sessions.get("planner", "codex-cli", "m1"), undefined);

    sessions.set("planner", "session-1", "codex-cli", "m1");
    assert.equal(sessions.get("planner", "codex-cli", "m1"), "session-1");
    assert.equal(sessions.get("planner", "codex-cli", "m2"), undefined);
    assert.equal(sessions.get("planner", "claude-cli", "m1"), undefined);

    sessions.clear("planner");
    assert.equal(sessions.get("planner", "codex-cli", "m1"), undefined);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
