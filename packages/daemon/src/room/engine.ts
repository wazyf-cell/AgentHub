import { randomUUID } from "node:crypto";
import type { RoomStore } from "./store.ts";
import { parseMentions, selectNextSpeaker, type PolicyState } from "./policy.ts";
import { composeTurnPrompt, estimateTokens } from "./transcript.ts";
import type {
  AgentBackend,
  AgentTurnResult,
  RoomConfig,
  RoomEvent,
  RoomEventDraft,
  RoomMember,
  RoomRules,
  StopReason,
} from "./types.ts";

export interface SummarizerInput {
  room: RoomConfig;
  events: RoomEvent[];
  member: RoomMember;
}

export interface SummarizerResult {
  summary: string;
  coveredEventId?: string;
}

export type RoomSummarizer = (input: SummarizerInput) => Promise<SummarizerResult | undefined>;

export interface RunRoomOptions {
  store: RoomStore;
  roomId: string;
  prompt: string;
  images?: string[];
  backend: AgentBackend;
  rulesOverride?: Partial<RoomRules>;
  signal?: AbortSignal;
  onEvent?: (event: RoomEvent) => void;
  summarizer?: RoomSummarizer;
}

export interface RoomRunResult {
  roomId: string;
  status: "completed" | "stopped" | "failed";
  stopReason: StopReason;
  detail?: string;
  agentTurns: number;
  costYuan: number;
  events: RoomEvent[];
}

const LOOP_GUARD = 500;

export async function runRoom(options: RunRoomOptions): Promise<RoomRunResult> {
  const { store, roomId, backend } = options;
  const storedRoom = store.readRoom(roomId);
  const room: RoomConfig = {
    ...storedRoom,
    rules: { ...storedRoom.rules, ...options.rulesOverride },
  };

  const append = (draft: RoomEventDraft): RoomEvent => {
    const event = store.appendEvent(roomId, draft);
    options.onEvent?.(event);
    return event;
  };

  const userMessage = append({
    type: "user_message",
    messageId: `msg-${randomUUID()}`,
    text: options.prompt,
    ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
  });
  if (userMessage.type !== "user_message") {
    throw new Error("Failed to append the user message.");
  }

  const initialMentions = parseMentions(options.prompt, room.members, room.rules.stopToken);
  const turnsSinceHuman: Record<string, number> = {};
  const totalTurnsByMember: Record<string, number> = {};
  for (const member of room.members) {
    turnsSinceHuman[member.id] = 0;
    totalTurnsByMember[member.id] = 0;
  }

  const state: PolicyState = {
    room,
    lastSpeakerId: undefined,
    consecutiveSameSpeaker: 0,
    agentTurns: 0,
    mentionQueue: initialMentions.memberIds,
    mentionQueueSource: "user",
    mentionsHuman: false,
    toldDone: false,
    totalCostYuan: 0,
    turnsSinceHuman,
    totalTurnsByMember,
  };

  let stopReason: StopReason = "error";
  let detail: string | undefined;
  let status: RoomRunResult["status"] = "failed";

  for (let guard = 0; guard < LOOP_GUARD; guard += 1) {
    if (options.signal?.aborted) {
      stopReason = "human_stop";
      detail = "stopped by the user";
      status = "stopped";
      append({ type: "room_stopped", reason: stopReason, detail });
      break;
    }

    const selection = selectNextSpeaker(state);
    if (selection.kind === "stop") {
      stopReason = selection.reason;
      detail = selection.detail;
      status = selection.reason === "done" ? "completed" : "stopped";
      append({ type: "room_stopped", reason: stopReason, detail });
      break;
    }

    const member = room.members.find((candidate) => candidate.id === selection.memberId);
    if (!member) {
      stopReason = "error";
      detail = `Selection returned unknown member "${selection.memberId}".`;
      status = "failed";
      append({ type: "error", message: detail });
      append({ type: "room_stopped", reason: stopReason, detail });
      break;
    }

    const turnId = `turn-${randomUUID()}`;
    const contextWindow = member.binding.contextWindow;
    const maxInputTokens = member.binding.contextBudget
      ?? (contextWindow ? Math.floor(contextWindow * (room.rules.summarizeAt ?? 0.7)) : undefined);
    const prompt = composeTurnPrompt({
      room,
      member,
      userPrompt: options.prompt,
      events: store.readEvents(roomId),
      brief: store.readBrief(roomId),
      summary: store.readSummary(roomId),
      maxInputTokens,
    });
    const promptTokens = estimateTokens(prompt);
    if (contextWindow && promptTokens > contextWindow * (room.rules.hardStopAt ?? 0.85)) {
      stopReason = "context_limit";
      detail = `prompt uses ${promptTokens}/${contextWindow} tokens; start a new room or pick a larger-context model`;
      status = "stopped";
      append({ type: "room_stopped", reason: stopReason, detail });
      break;
    }

    if (state.lastSpeakerId && state.lastSpeakerId !== member.id) {
      append({
        type: "handoff",
        fromMemberId: state.lastSpeakerId,
        toMemberId: member.id,
        reason: selection.reason,
      });
    }

    append({
      type: "turn_started",
      turnId,
      memberId: member.id,
      memberName: member.name,
      reason: selection.reason,
      platformId: member.binding.platformId,
      modelId: member.binding.modelId,
    });

    let result: AgentTurnResult;
    try {
      result = await backend.runTurn({
        room,
        member,
        prompt,
        turnId,
        images: options.images,
        signal: options.signal,
        onDelta: (text) => {
          if (!text) {
            return;
          }
          append({ type: "agent_delta", turnId, memberId: member.id, text });
        },
      });
    } catch (error) {
      result = {
        text: "",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (options.signal?.aborted) {
      await recordAbortedTurn({ append, store, roomId, turnId, member, prompt, result });
      stopReason = "human_stop";
      detail = "stopped by the user";
      status = "stopped";
      append({ type: "room_stopped", reason: stopReason, detail });
      break;
    }

    if (result.status !== "completed") {
      const message = result.error ?? "agent turn failed";
      append({
        type: "turn_finished",
        turnId,
        memberId: member.id,
        status: "failed",
        usage: result.usage,
        costYuan: result.costYuan,
        error: message,
      });
      append({ type: "error", message, turnId });
      append({ type: "room_stopped", reason: "error", detail: message });
      stopReason = "error";
      detail = message;
      status = "failed";
      break;
    }

    if (
      result.usedBinding
      && (result.usedBinding.platformId !== member.binding.platformId
        || result.usedBinding.modelId !== member.binding.modelId)
    ) {
      append({
        type: "binding_used",
        turnId,
        memberId: member.id,
        requested: {
          platformId: member.binding.platformId,
          modelId: member.binding.modelId,
        },
        used: result.usedBinding,
        fallbacks: result.fallbacks ?? [],
      });
    }

    const parsed = parseMentions(result.text, room.members, room.rules.stopToken);
    append({
      type: "agent_message",
      turnId,
      memberId: member.id,
      memberName: member.name,
      text: result.text,
      mentions: parsed.memberIds,
      mentionsHuman: parsed.mentionsHuman,
      done: parsed.done,
    });
    append({
      type: "turn_finished",
      turnId,
      memberId: member.id,
      status: "completed",
      usage: result.usage,
      costYuan: result.costYuan,
    });
    store.writeRunArtifact(roomId, turnId, {
      roomId,
      turnId,
      member: {
        id: member.id,
        name: member.name,
        platformId: member.binding.platformId,
        modelId: member.binding.modelId,
      },
      prompt,
      result,
    });

    state.agentTurns += 1;
    state.totalCostYuan += result.costYuan ?? 0;
    state.totalTurnsByMember[member.id] = (state.totalTurnsByMember[member.id] ?? 0) + 1;
    for (const id of Object.keys(state.turnsSinceHuman)) {
      state.turnsSinceHuman[id] = (state.turnsSinceHuman[id] ?? 0) + 1;
    }
    state.consecutiveSameSpeaker = state.lastSpeakerId === member.id ? state.consecutiveSameSpeaker + 1 : 1;
    state.lastSpeakerId = member.id;
    state.mentionQueue = parsed.memberIds.filter((memberId) => memberId !== member.id);
    state.mentionQueueSource = "agent";
    state.mentionsHuman = parsed.mentionsHuman;
    state.toldDone = parsed.done;

    if (
      options.summarizer
      && contextWindow
      && promptTokens > contextWindow * (room.rules.summarizeAt ?? 0.7)
    ) {
      try {
        const summary = await options.summarizer({
          room,
          events: store.readEvents(roomId),
          member,
        });
        if (summary?.summary.trim()) {
          store.writeSummary(roomId, `${summary.summary.trim()}\n`);
          append({
            type: "summary_updated",
            path: "summary.md",
            coveredEventId: summary.coveredEventId,
          });
        }
      } catch (error) {
        append({
          type: "error",
          message: `summary failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  if (status === "failed" && stopReason === "error" && !detail) {
    detail = "room loop guard exhausted";
    append({ type: "room_stopped", reason: "error", detail });
  }

  return {
    roomId,
    status,
    stopReason,
    detail,
    agentTurns: state.agentTurns,
    costYuan: state.totalCostYuan,
    events: store.readEvents(roomId),
  };
}

async function recordAbortedTurn(args: {
  append: (draft: RoomEventDraft) => RoomEvent;
  store: RoomStore;
  roomId: string;
  turnId: string;
  member: RoomMember;
  prompt: string;
  result: AgentTurnResult;
}): Promise<void> {
  const { append, store, roomId, turnId, member, prompt, result } = args;
  append({
    type: "turn_finished",
    turnId,
    memberId: member.id,
    status: "failed",
    usage: result.usage,
    costYuan: result.costYuan,
    error: "aborted",
  });
  store.writeRunArtifact(roomId, turnId, {
    roomId,
    turnId,
    member: {
      id: member.id,
      name: member.name,
      platformId: member.binding.platformId,
      modelId: member.binding.modelId,
    },
    prompt,
    result,
    aborted: true,
  });
}
