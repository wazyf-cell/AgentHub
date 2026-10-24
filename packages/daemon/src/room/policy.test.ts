import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoRoomConfig } from "./demo.ts";
import { parseMentions, selectNextSpeaker, type PolicyState } from "./policy.ts";

function baseState(overrides: Partial<PolicyState> = {}): PolicyState {
  const room = overrides.room ?? buildDemoRoomConfig(".");
  const turnsSinceHuman: Record<string, number> = {};
  const totalTurnsByMember: Record<string, number> = {};
  for (const member of room.members) {
    turnsSinceHuman[member.id] = 0;
    totalTurnsByMember[member.id] = 0;
  }
  return {
    room,
    consecutiveSameSpeaker: 0,
    agentTurns: 0,
    mentionQueue: [],
    mentionQueueSource: "user",
    mentionsHuman: false,
    toldDone: false,
    totalCostYuan: 0,
    ...overrides,
    turnsSinceHuman: {
      ...turnsSinceHuman,
      ...(overrides.turnsSinceHuman ?? {}),
    },
    totalTurnsByMember: {
      ...totalTurnsByMember,
      ...(overrides.totalTurnsByMember ?? {}),
    },
  };
}

test("first speaker is chosen by fairness in room order", () => {
  const selection = selectNextSpeaker(baseState());
  assert.equal(selection.kind, "speak");
  if (selection.kind === "speak") {
    assert.equal(selection.memberId, "planner");
    assert.equal(selection.reason, "fairness");
  }
});

test("a user mention wins over fairness", () => {
  const selection = selectNextSpeaker(baseState({ mentionQueue: ["reviewer"] }));
  assert.deepEqual(selection, { kind: "speak", memberId: "reviewer", reason: "user_mention" });
});

test("an agent mention is labelled as agent_mention", () => {
  const selection = selectNextSpeaker(
    baseState({ agentTurns: 1, lastSpeakerId: "planner", consecutiveSameSpeaker: 1, mentionQueue: ["implementer"], mentionQueueSource: "agent" }),
  );
  assert.deepEqual(selection, { kind: "speak", memberId: "implementer", reason: "agent_mention" });
});

test("self-mentions are skipped and fairness picks someone else", () => {
  const selection = selectNextSpeaker(
    baseState({
      agentTurns: 1,
      lastSpeakerId: "planner",
      consecutiveSameSpeaker: 1,
      mentionQueue: ["planner"],
      mentionQueueSource: "agent",
      turnsSinceHuman: { planner: 1 },
    }),
  );
  assert.equal(selection.kind, "speak");
  if (selection.kind === "speak") {
    assert.notEqual(selection.memberId, "planner");
    assert.equal(selection.reason, "fairness");
  }
});

test("DONE stops the room", () => {
  assert.deepEqual(selectNextSpeaker(baseState({ toldDone: true })), { kind: "stop", reason: "done" });
});

test("a human mention stops the room", () => {
  const selection = selectNextSpeaker(baseState({ mentionsHuman: true }));
  assert.equal(selection.kind, "stop");
  if (selection.kind === "stop") {
    assert.equal(selection.reason, "human_mention");
  }
});

test("maxHandoffs stops the room", () => {
  const room = buildDemoRoomConfig(".");
  room.rules.maxHandoffs = 1;
  const selection = selectNextSpeaker(baseState({ room, agentTurns: 1 }));
  assert.equal(selection.kind, "stop");
  if (selection.kind === "stop") {
    assert.equal(selection.reason, "max_handoffs");
  }
});

test("low autonomy stops after one agent turn", () => {
  const room = buildDemoRoomConfig(".");
  room.rules.autonomy = "low";
  const selection = selectNextSpeaker(baseState({ room, agentTurns: 1 }));
  assert.equal(selection.kind, "stop");
  if (selection.kind === "stop") {
    assert.equal(selection.reason, "autonomy_low");
  }
});

test("budget stops the room", () => {
  const room = buildDemoRoomConfig(".");
  room.rules.budgetYuan = 1;
  const selection = selectNextSpeaker(baseState({ room, totalCostYuan: 1 }));
  assert.equal(selection.kind, "stop");
  if (selection.kind === "stop") {
    assert.equal(selection.reason, "budget");
  }
});

test("plan order follows the configured sequence", () => {
  const room = buildDemoRoomConfig(".");
  room.rules.planOrder = ["reviewer", "planner", "implementer"];
  const selection = selectNextSpeaker(
    baseState({ room, agentTurns: 1, lastSpeakerId: "reviewer", consecutiveSameSpeaker: 1, turnsSinceHuman: { reviewer: 1 } }),
  );
  assert.deepEqual(selection, { kind: "speak", memberId: "planner", reason: "plan_order" });
});

test("members with zero weight do not speak unless mentioned", () => {
  const room = buildDemoRoomConfig(".");
  room.members[0].behavior = { weight: 0 };
  const selection = selectNextSpeaker(baseState({ room }));
  assert.equal(selection.kind, "speak");
  if (selection.kind === "speak") {
    assert.equal(selection.memberId, "implementer");
  }
});

test("parseMentions handles ids, names, human mentions and DONE", () => {
  const room = buildDemoRoomConfig(".");
  const parsed = parseMentions("请 @规划者 和 @implementer 看一下，@你 也确认一下。DONE", room.members, "DONE");
  assert.deepEqual(new Set(parsed.memberIds), new Set(["planner", "implementer"]));
  assert.equal(parsed.mentionsHuman, true);
  assert.equal(parsed.done, true);
});

test("parseMentions matches a Chinese member name", () => {
  const room = buildDemoRoomConfig(".");
  room.members[0].name = "前端";
  const parsed = parseMentions("交给 @前端 处理", room.members, "DONE");
  assert.deepEqual(parsed.memberIds, ["planner"]);
  assert.equal(parsed.done, false);
});

test("isDone does not fire on unrelated text", () => {
  const room = buildDemoRoomConfig(".");
  const parsed = parseMentions("这项工作还没有完成，需要继续。", room.members, "DONE");
  assert.equal(parsed.done, false);
});
