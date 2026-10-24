import assert from "node:assert/strict";
import test from "node:test";
import { cacheHitRate, computeRoomStats, parseSince, roomSpent, summarizeTasks } from "./stats.ts";
import type { RoomTask } from "./tasks.ts";
import type { RoomConfig, RoomEvent } from "./types.ts";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function room(): RoomConfig {
  return {
    version: 1,
    id: "demo",
    name: "统计房间",
    workspace: "F:/repo",
    members: [
      {
        id: "m1",
        name: "架构师",
        role: "架构",
        instructions: "",
        binding: { platformId: "codex-cli", modelId: "glm-5.3-flash", contextWindow: 200_000 },
      },
      {
        id: "m2",
        name: "实现者",
        role: "实现",
        instructions: "",
        binding: { platformId: "aiwork-api", modelId: "deepseek-v4.1-flash", contextWindow: 128_000 },
      },
    ],
    rules: { autonomy: "medium", maxHandoffs: 6 },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function turn(
  id: string,
  ts: string,
  memberId: string,
  usage: { input?: number; output?: number; cache?: number; total?: number },
  extra: Partial<Extract<RoomEvent, { type: "turn_finished" }>> = {},
): RoomEvent {
  return {
    v: 1,
    id,
    ts,
    roomId: "demo",
    type: "turn_finished",
    turnId: `turn-${id}`,
    memberId,
    status: "completed",
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cache,
      contextTokens: usage.input,
      totalTokens: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
    },
    costYuan: 0.1,
    ...extra,
  } as RoomEvent;
}

function task(id: string, status: RoomTask["status"], cost: number, usage: number): RoomTask {
  return {
    id,
    title: id,
    description: "",
    ownerMemberId: "m1",
    acceptance: "",
    dependsOn: [],
    status,
    attempt: 1,
    costYuan: cost,
    usageTokens: usage,
    inputTokens: usage - 5,
    outputTokens: 5,
    cacheReadTokens: 0,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

test("stats include task costs and tokens in room totals", () => {
  const events = [turn("1", new Date(NOW).toISOString(), "m1", { input: 100, output: 20 })];
  const tasks = [task("t1", "done", 1.5, 500), task("t2", "failed", 0.5, 100)];
  const stats = computeRoomStats(room(), events, [], { now: NOW, tasks });
  assert.equal(stats.tasks.tasks, 2);
  assert.equal(stats.tasks.done, 1);
  assert.equal(stats.tasks.failed, 1);
  assert.equal(stats.totals.costYuan, 0.1 + 2);
  assert.equal(stats.totals.totalTokens, 120 + 600);
  assert.equal(stats.totals.inputTokens, 100 + 590);
  assert.equal(summarizeTasks(tasks).costYuan, 2);
  assert.deepEqual(roomSpent(events, tasks), { costYuan: 2.1, totalTokens: 720 });
});

test("stats aggregate totals, members, models and days", () => {
  const events: RoomEvent[] = [
    turn("1", "2026-10-23T08:00:00.000Z", "m1", { input: 100, output: 20, cache: 40 }, { platformId: "codex-cli", modelId: "glm-5.3-flash" }),
    turn("2", "2026-10-24T08:00:00.000Z", "m2", { input: 50, output: 10 }, { platformId: "aiwork-api", modelId: "deepseek-v4.1-flash" }),
    turn("3", "2026-10-24T09:00:00.000Z", "m1", { input: 30, output: 5 }, { status: "failed", platformId: "codex-cli", modelId: "glm-5.3-flash" }),
  ];
  const stats = computeRoomStats(room(), events, [], { now: NOW });
  assert.equal(stats.totals.requests, 3);
  assert.equal(stats.totals.failed, 1);
  assert.equal(stats.totals.inputTokens, 180);
  assert.equal(stats.totals.outputTokens, 35);
  assert.equal(stats.totals.cacheReadTokens, 40);
  assert.equal(stats.totals.totalTokens, 215);
  assert.equal(stats.byMember.length, 2);
  assert.equal(stats.byMember[0].label, "架构师");
  assert.equal(stats.byMember[0].requests, 2);
  assert.equal(stats.byModel.length, 2);
  assert.equal(stats.byDay.length, 2);
  assert.equal(stats.byDay[0].key, "2026-10-23");
  assert.equal(stats.lastTurn?.modelId, "glm-5.3-flash");
  assert.equal(stats.lastTurn?.contextWindow, 200_000);
  assert.equal(cacheHitRate(stats.totals), 40 / 180);
});

test("stats honor since filters", () => {
  const events = [
    turn("old", new Date(NOW - 8 * 86_400_000).toISOString(), "m1", { input: 100, output: 10 }),
    turn("new", new Date(NOW - 3_600_000).toISOString(), "m2", { input: 20, output: 2 }),
  ];
  assert.equal(computeRoomStats(room(), events, [], { now: NOW }).totals.requests, 2);
  assert.equal(computeRoomStats(room(), events, [], { now: NOW, since: "7d" }).totals.requests, 1);
  assert.equal(computeRoomStats(room(), events, [], { now: NOW, since: "24h" }).totals.inputTokens, 20);
  assert.equal(parseSince("2026-10-20", NOW), Date.parse("2026-10-20"));
  assert.equal(parseSince("all", NOW), undefined);
});

test("stats fall back to member binding for legacy events", () => {
  const legacy = {
    v: 1,
    id: "legacy",
    ts: new Date(NOW).toISOString(),
    roomId: "demo",
    type: "turn_finished",
    turnId: "t",
    memberId: "m2",
    status: "completed",
    usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
  } as RoomEvent;
  const stats = computeRoomStats(room(), [legacy], [], { now: NOW });
  assert.equal(stats.byModel[0].key, "aiwork-api/deepseek-v4.1-flash");
  assert.equal(stats.lastTurn?.contextWindow, 128_000);
});
