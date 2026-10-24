import { randomUUID } from "node:crypto";
import type { RoomSummarizer, SummarizerResult } from "./engine.ts";
import { formatConversation } from "./transcript.ts";
import type { AgentBackend, RoomMember } from "./types.ts";

export function createRoomSummarizer(
  backend: AgentBackend,
  member: RoomMember,
  options: { signal?: AbortSignal } = {},
): RoomSummarizer {
  return async ({ room, events }): Promise<SummarizerResult | undefined> => {
    const conversation = formatConversation(events, 60);
    if (!conversation.trim()) {
      return undefined;
    }
    const prompt = [
      "你是一个房间记录压缩器，不是参与者。",
      "把下面的对话压缩成一份给后续成员看的简报，必须保留：",
      "## 目标",
      "## 已定结论",
      "## 未决问题",
      "## 约束与禁止事项",
      "## 关键产物或文件",
      "不要编造对话里没有的内容；只输出 Markdown，不要输出别的。",
      "",
      conversation,
    ].join("\n\n");

    const result = await backend.runTurn({
      room,
      member,
      prompt,
      turnId: `summary-${randomUUID()}`,
      signal: options.signal,
    });
    if (result.status !== "completed" || !result.text.trim()) {
      return undefined;
    }
    const lastAgentMessage = [...events].reverse().find((event) => event.type === "agent_message");
    return {
      summary: result.text.trim(),
      coveredEventId: lastAgentMessage?.id,
    };
  };
}
