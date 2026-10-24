import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeBackend, createDemoFakeBackend } from "./backends/fake.ts";
import { createDemoRoom } from "./demo.ts";
import { runRoom } from "./engine.ts";
import { RoomStore } from "./store.ts";
import type { AgentBackend, RoomEvent } from "./types.ts";

function createStore(): { dataDir: string; store: RoomStore; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), "agenthub-room-engine-"));
  const store = new RoomStore(dataDir);
  createDemoRoom(store, process.cwd());
  return {
    dataDir,
    store,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("demo room runs planner -> implementer -> reviewer -> DONE", async () => {
  const { store, cleanup } = createStore();
  const streamed: RoomEvent[] = [];
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "设计成员配置界面",
      backend: createDemoFakeBackend(),
      onEvent: (event) => streamed.push(event),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.stopReason, "done");
    assert.equal(result.agentTurns, 3);

    const messages = result.events.filter(
      (event): event is Extract<RoomEvent, { type: "agent_message" }> => event.type === "agent_message",
    );
    assert.deepEqual(messages.map((message) => message.memberId), ["planner", "implementer", "reviewer"]);

    const handoffs = result.events.filter(
      (event): event is Extract<RoomEvent, { type: "handoff" }> => event.type === "handoff",
    );
    assert.deepEqual(
      handoffs.map((handoff) => [handoff.fromMemberId, handoff.toMemberId]),
      [
        ["planner", "implementer"],
        ["implementer", "reviewer"],
      ],
    );
    assert.ok(result.events.some((event) => event.type === "room_stopped" && event.reason === "done"));
    assert.ok(streamed.some((event) => event.type === "agent_delta"));
    assert.equal(readdirSync(join(store.roomDir("demo"), "runs")).length, 3);
  } finally {
    cleanup();
  }
});

test("inline file references are appended only for API-style members", async () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-engine-refs-"));
  const store = new RoomStore(join(root, "data"));
  createDemoRoom(store, root);
  writeFileSync(join(root, "note.md"), "引用内容 42\n");
  const prompts: string[] = [];
  const backend: AgentBackend = {
    id: "capture",
    async runTurn(request) {
      prompts.push(request.prompt);
      return { text: "DONE", status: "completed", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  try {
    const inline = await runRoom({
      store,
      roomId: "demo",
      prompt: "看看 @note.md",
      backend,
      fileRefMode: () => "inline",
    });
    assert.equal(inline.stopReason, "done");
    assert.ok(prompts[0].includes("## 引用文件"));
    assert.ok(prompts[0].includes("引用内容 42"));

    prompts.length = 0;
    await runRoom({
      store,
      roomId: "demo",
      prompt: "再看一次 @note.md",
      backend,
      fileRefMode: () => "path",
    });
    assert.ok(!prompts[0].includes("引用内容 42"));
    assert.ok(prompts[0].includes("@note.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maxHandoffs stops the room after the configured number of turns", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "一直做下去",
      backend: createDemoFakeBackend(),
      rulesOverride: { maxHandoffs: 1 },
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "max_handoffs");
    assert.equal(result.agentTurns, 1);
  } finally {
    cleanup();
  }
});

test("low autonomy stops after one agent turn", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "先做一个回合",
      backend: createDemoFakeBackend(),
      rulesOverride: { autonomy: "low" },
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "autonomy_low");
    assert.equal(result.agentTurns, 1);
  } finally {
    cleanup();
  }
});

test("a backend failure stops the room and records the error", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "模拟失败",
      backend: new FakeBackend({ failFor: ["planner"] }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "error");
    assert.equal(result.agentTurns, 0);
    assert.ok(result.events.some((event) => event.type === "error"));
    assert.ok(result.events.some((event) => event.type === "room_stopped" && event.reason === "error"));
  } finally {
    cleanup();
  }
});

test("a member can stop the room by mentioning the human", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "需要人确认的场景",
      backend: new FakeBackend({ replies: { planner: "这里需要你确认。@你" } }),
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "human_mention");
    assert.equal(result.agentTurns, 1);
  } finally {
    cleanup();
  }
});

test("budget stops the room before another turn", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "预算很小的任务",
      backend: new FakeBackend({
        costPerTurnYuan: 1,
        replies: { planner: "继续下一步。@implementer" },
      }),
      rulesOverride: { budgetYuan: 1 },
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "budget");
    assert.equal(result.agentTurns, 1);
    assert.equal(result.costYuan, 1);
  } finally {
    cleanup();
  }
});

test("a user mention targets the first speaker", async () => {
  const { store, cleanup } = createStore();
  try {
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "@reviewer 直接给结论",
      backend: createDemoFakeBackend(),
    });
    const started = result.events.find(
      (event): event is Extract<RoomEvent, { type: "turn_started" }> => event.type === "turn_started",
    );
    assert.ok(started);
    assert.equal(started?.memberId, "reviewer");
    assert.equal(started?.reason, "user_mention");
  } finally {
    cleanup();
  }
});

test("a prompt over the hard context limit stops before a turn", async () => {
  const { store, cleanup } = createStore();
  try {
    const room = store.readRoom("demo");
    room.members[0].binding.contextWindow = 100;
    room.members[0].binding.contextBudget = 90;
    store.writeRoom(room);
    store.writeBrief("demo", "很长的简报。".repeat(120));

    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "做点什么",
      backend: createDemoFakeBackend(),
      rulesOverride: { planOrder: ["planner"] },
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "context_limit");
    assert.equal(result.agentTurns, 0);
  } finally {
    cleanup();
  }
});

test("the summarizer runs once the prompt crosses the summarize threshold", async () => {
  const { store, cleanup } = createStore();
  try {
    const room = store.readRoom("demo");
    room.members[0].binding.contextWindow = 2_000;
    room.members[0].binding.contextBudget = 2_000;
    store.writeRoom(room);
    store.writeBrief("demo", "简报内容。".repeat(300));

    let calls = 0;
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "给一个简短方案",
      backend: createDemoFakeBackend(),
      rulesOverride: { maxHandoffs: 1, planOrder: ["planner"], hardStopAt: 0.95 },
      summarizer: async () => {
        calls += 1;
        return { summary: "压缩后的摘要" };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.stopReason, "max_handoffs");
    assert.match(store.readSummary("demo"), /压缩后的摘要/);
    assert.ok(result.events.some((event) => event.type === "summary_updated"));
  } finally {
    cleanup();
  }
});

test("auto compaction triggers from conversation history without an explicit context budget", async () => {
  const { store, cleanup } = createStore();
  try {
    const room = store.readRoom("demo");
    room.members[0].binding.contextWindow = 4_000;
    room.members[0].binding.contextBudget = undefined;
    store.writeRoom(room);
    store.writeBrief("demo", "简报。".repeat(40));
    for (let index = 0; index < 12; index += 1) {
      store.appendEvent("demo", {
        type: "user_message",
        messageId: `history-${index}`,
        text: "历史消息。".repeat(120),
      });
    }

    let calls = 0;
    await runRoom({
      store,
      roomId: "demo",
      prompt: "继续",
      backend: createDemoFakeBackend(),
      rulesOverride: { maxHandoffs: 1, planOrder: ["planner"], summarizeAt: 0.7, hardStopAt: 0.9 },
      summarizer: async () => {
        calls += 1;
        return { summary: "自动压缩摘要" };
      },
    });

    assert.equal(calls, 1);
    assert.match(store.readSummary("demo"), /自动压缩摘要/);
  } finally {
    cleanup();
  }
});

test("an abort before the first turn records a human stop", async () => {
  const { store, cleanup } = createStore();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runRoom({
      store,
      roomId: "demo",
      prompt: "立即停止",
      backend: createDemoFakeBackend(),
      signal: controller.signal,
    });
    assert.equal(result.status, "stopped");
    assert.equal(result.stopReason, "human_stop");
    assert.equal(result.agentTurns, 0);
  } finally {
    cleanup();
  }
});
