import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackSummarizer } from "./summary.ts";
import type { AgentBackend, RoomConfig, RoomEvent, RoomMember } from "./types.ts";

function member(id: string, modelId: string): RoomMember {
  return {
    id,
    name: id,
    role: "摘要",
    instructions: "压缩记录",
    binding: { platformId: "codex-cli", modelId },
  };
}

const room: RoomConfig = {
  version: 1,
  id: "room",
  name: "room",
  workspace: "",
  members: [member("first", "broken"), member("second", "empty"), member("third", "ok")],
  rules: { autonomy: "medium", maxHandoffs: 4 },
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
};

const events: RoomEvent[] = [{
  v: 1,
  id: "evt-1",
  ts: "2026-10-24T00:00:00.000Z",
  roomId: "room",
  type: "user_message",
  messageId: "msg-1",
  text: "把方案压缩一下",
}];

test("fallback summarizer tries the next model after failures or empty summaries", async () => {
  const attempts: string[] = [];
  const backend: AgentBackend = {
    id: "summary-test",
    async runTurn(request) {
      attempts.push(request.member.id);
      if (request.member.id === "first") throw new Error("provider down");
      if (request.member.id === "second") return { status: "failed", text: "" };
      return { status: "completed", text: "## 目标\n继续实现" };
    },
  };

  const summarizer = createFallbackSummarizer(
    backend,
    [member("first", "broken"), member("second", "empty"), member("third", "ok")],
    { timeoutMs: 2_000 },
  );
  const result = await summarizer({ room, events, member: room.members[0] });

  assert.equal(result?.summary, "## 目标\n继续实现");
  assert.deepEqual(attempts, ["first", "second", "third"]);
});

test("fallback summarizer reports the last error when every model fails", async () => {
  const backend: AgentBackend = {
    id: "summary-test",
    async runTurn() {
      return { status: "failed", text: "" };
    },
  };
  const summarizer = createFallbackSummarizer(backend, [member("first", "broken")], { timeoutMs: 2_000 });
  await assert.rejects(
    () => summarizer({ room, events, member: room.members[0] }),
    /codex-cli\/broken 没有返回摘要/,
  );
});
