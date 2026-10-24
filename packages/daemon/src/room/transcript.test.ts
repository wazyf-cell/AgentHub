import assert from "node:assert/strict";
import test from "node:test";
import { buildDemoRoomConfig } from "./demo.ts";
import { composeTurnPrompt, estimateTokens } from "./transcript.ts";
import type { RoomEvent } from "./types.ts";

function userEvent(index: number, text: string): RoomEvent {
  return {
    v: 1,
    id: `evt-${index}`,
    ts: new Date().toISOString(),
    roomId: "demo",
    type: "user_message",
    messageId: `msg-${index}`,
    text,
  };
}

test("the composed prompt contains role, brief, summary, task and handoff rules", () => {
  const room = buildDemoRoomConfig(".");
  const member = room.members[0];
  const prompt = composeTurnPrompt({
    room,
    member,
    userPrompt: "设计成员配置界面",
    events: [userEvent(1, "先看一下现有结构")],
    brief: "# 简报\n目标：做出本地房间",
    summary: "之前确认过只读模式",
  });

  assert.match(prompt, /你是 规划者/);
  assert.match(prompt, /设计成员配置界面/);
  assert.match(prompt, /目标：做出本地房间/);
  assert.match(prompt, /之前确认过只读模式/);
  assert.match(prompt, /@成员名/);
  assert.match(prompt, /只读/);
});

test("the prompt drops older messages when the budget is small", () => {
  const room = buildDemoRoomConfig(".");
  const member = room.members[0];
  const events = Array.from({ length: 8 }, (_, index) =>
    userEvent(index, `第 ${index} 条消息 ${"内容".repeat(40)} MARKER_${index}`),
  );
  const prompt = composeTurnPrompt({
    room,
    member,
    userPrompt: "继续",
    events,
    recentLimit: 8,
    maxInputTokens: 400,
  });

  assert.match(prompt, /MARKER_7/);
  assert.doesNotMatch(prompt, /MARKER_0/);
  assert.match(prompt, /较早的/);
});

test("token estimation counts CJK more heavily than latin text", () => {
  assert.ok(estimateTokens("这是一段中文") > estimateTokens("hello"));
});
