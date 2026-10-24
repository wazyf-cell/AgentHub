import type { RoomConfig, RoomEvent, RoomMember } from "./types.ts";

export interface ComposeTurnPromptInput {
  room: RoomConfig;
  member: RoomMember;
  userPrompt: string;
  events: RoomEvent[];
  brief?: string;
  summary?: string;
  recentLimit?: number;
  maxInputTokens?: number;
}

const DEFAULT_RECENT_LIMIT = 15;
const DEFAULT_MAX_INPUT_TOKENS = 8000;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(char)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4) + 8;
}

export function formatConversation(events: RoomEvent[], limit = DEFAULT_RECENT_LIMIT): string {
  const messages = events.filter(
    (event): event is Extract<RoomEvent, { type: "user_message" | "agent_message" }> =>
      event.type === "user_message" || event.type === "agent_message",
  );
  return messages
    .slice(-limit)
    .map((message) => {
      if (message.type === "user_message") {
        return `[你] ${message.text}`;
      }
      return `[${message.memberName}] ${message.text}`;
    })
    .join("\n\n");
}

export function composeTurnPrompt(input: ComposeTurnPromptInput): string {
  const recentLimit = input.recentLimit ?? DEFAULT_RECENT_LIMIT;
  const maxInputTokens = input.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const stopToken = input.room.rules.stopToken ?? "DONE";
  const brief = input.brief?.trim() || buildDefaultBrief(input.room);
  const summary = input.summary?.trim();

  const messages = input.events.filter(
    (event): event is Extract<RoomEvent, { type: "user_message" | "agent_message" }> =>
      event.type === "user_message" || event.type === "agent_message",
  );
  let recent = messages.slice(-recentLimit);
  let omitted = 0;

  const build = (): string => {
    const conversation = recent
      .map((message) =>
        message.type === "user_message" ? `[你] ${message.text}` : `[${message.memberName}] ${message.text}`,
      )
      .join("\n\n");
    const permissionNote =
      input.member.permissions?.write === true
        ? "当前成员允许在房间工作区内写入；仍须遵守简报里的路径约束。"
        : "当前房间只读：不要修改任何文件，只输出分析、方案或补丁建议。";
    return [
      `你是 ${input.member.name}，房间角色：${input.member.role}。`,
      input.member.instructions,
      `房间：${input.room.name}`,
      `房间简报：\n${brief}`,
      summary ? `较早内容摘要：\n${summary}` : "",
      `最近对话：\n${omitted > 0 ? `（较早的 ${omitted} 条消息已省略）\n` : ""}${conversation || "（还没有消息）"}`,
      `当前任务：\n${input.userPrompt}`,
      permissionNote,
      `交接规则：需要指定下一位发言者时，在回复里写 @成员名；如果任务已经完成，以 ${stopToken} 结尾。`,
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  while (estimateTokens(build()) > maxInputTokens && recent.length > 1) {
    recent = recent.slice(1);
    omitted += 1;
  }

  return build();
}

function buildDefaultBrief(room: RoomConfig): string {
  const members = room.members.map((member) => `- ${member.name}：${member.role}`).join("\n");
  return `目标：围绕当前任务协作。\n成员：\n${members}\n约束：v1 只读，不修改工作区文件。`;
}
