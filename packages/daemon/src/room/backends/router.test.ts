import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoRoom } from "../demo.ts";
import { HealthChecker } from "../health.ts";
import { SessionStore } from "../sessions.ts";
import { RoomStore } from "../store.ts";
import type { AgentBackend, AgentTurnResult, ModelDescriptor, PlatformConfig, RoomMember } from "../types.ts";
import { RoomBackendRouter } from "./router.ts";

function failingBackend(id: string): AgentBackend {
  return {
    id,
    async runTurn(): Promise<AgentTurnResult> {
      return { text: "", status: "failed", error: `${id} failed` };
    },
  };
}

function okBackend(id: string): AgentBackend {
  return {
    id,
    async runTurn(): Promise<AgentTurnResult> {
      return { text: "ok", status: "completed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costYuan: 0.01 };
    },
  };
}

test("the router falls back to the next binding and reports it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-router-"));
  const store = new RoomStore(dataDir);
  try {
    const room = createDemoRoom(store, process.cwd());
    const platforms: PlatformConfig[] = [
      { id: "p1", name: "P1", kind: "fake", enabled: true },
      { id: "p2", name: "P2", kind: "fake", enabled: true },
    ];
    const models: ModelDescriptor[] = [
      { platformId: "p1", modelId: "m1", displayName: "M1", enabled: true },
      { platformId: "p2", modelId: "m2", displayName: "M2", enabled: true },
    ];
    const member: RoomMember = {
      ...room.members[0],
      binding: {
        platformId: "p1",
        modelId: "m1",
        fallback: [{ platformId: "p2", modelId: "m2" }],
      },
    };
    const router = new RoomBackendRouter({
      store,
      roomId: "demo",
      platforms,
      models,
      sessions: new SessionStore(store, "demo"),
      health: new HealthChecker(0),
      createBackend: (platform) => (platform.id === "p1" ? failingBackend("p1") : okBackend("p2")),
    });

    const result = await router.runTurn({
      room,
      member,
      prompt: "test",
      turnId: "turn-test",
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.usedBinding, { platformId: "p2", modelId: "m2" });
    assert.equal(result.fallbacks?.length, 1);
    assert.equal(result.fallbacks?.[0].platformId, "p1");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the router fails when every binding fails", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-router-fail-"));
  const store = new RoomStore(dataDir);
  try {
    const room = createDemoRoom(store, process.cwd());
    const member: RoomMember = {
      ...room.members[0],
      binding: { platformId: "p1", modelId: "m1" },
    };
    const router = new RoomBackendRouter({
      store,
      roomId: "demo",
      platforms: [{ id: "p1", name: "P1", kind: "fake", enabled: true }],
      models: [{ platformId: "p1", modelId: "m1", displayName: "M1", enabled: true }],
      sessions: new SessionStore(store, "demo"),
      health: new HealthChecker(0),
      createBackend: () => failingBackend("p1"),
    });

    const result = await router.runTurn({ room, member, prompt: "test", turnId: "turn-test" });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /all bindings failed/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
