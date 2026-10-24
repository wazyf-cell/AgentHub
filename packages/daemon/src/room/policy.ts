import type { RoomConfig, RoomMember, StopReason, TurnReason } from "./types.ts";

export interface PolicyState {
  room: RoomConfig;
  lastSpeakerId?: string;
  consecutiveSameSpeaker: number;
  agentTurns: number;
  mentionQueue: string[];
  mentionQueueSource: "user" | "agent";
  mentionsHuman: boolean;
  toldDone: boolean;
  totalCostYuan: number;
  turnsSinceHuman: Record<string, number>;
  totalTurnsByMember: Record<string, number>;
}

export type Selection =
  | { kind: "speak"; memberId: string; reason: TurnReason }
  | { kind: "stop"; reason: StopReason; detail?: string };

export interface ParsedMessage {
  memberIds: string[];
  mentionsHuman: boolean;
  done: boolean;
}

const DEFAULT_MAX_HANDOFFS = 8;
const DEFAULT_STOP_TOKEN = "DONE";
const HUMAN_TOKENS = new Set(["human", "user", "you", "你", "我"]);
const ALL_TOKENS = new Set(["all", "everyone", "所有人", "大家"]);

export function parseMentions(text: string, members: RoomMember[], stopToken = DEFAULT_STOP_TOKEN): ParsedMessage {
  const memberIds = new Set<string>();
  const normalized = text.toLowerCase();
  const byToken = new Map<string, string>();

  for (const member of members) {
    byToken.set(member.id.toLowerCase(), member.id);
    byToken.set(member.name.toLowerCase(), member.id);
    if (normalized.includes(`@${member.name.toLowerCase()}`) || normalized.includes(`@${member.id.toLowerCase()}`)) {
      memberIds.add(member.id);
    }
  }

  let mentionsHuman = false;
  for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const token = match[1].toLowerCase();
    if (HUMAN_TOKENS.has(token)) {
      mentionsHuman = true;
      continue;
    }
    if (ALL_TOKENS.has(token)) {
      for (const member of members) {
        memberIds.add(member.id);
      }
      continue;
    }
    const memberId = byToken.get(token);
    if (memberId) {
      memberIds.add(memberId);
    }
  }

  return {
    memberIds: [...memberIds],
    mentionsHuman,
    done: isDone(text, stopToken),
  };
}

export function isDone(text: string, stopToken = DEFAULT_STOP_TOKEN): boolean {
  const trimmed = text.trim();
  if (!trimmed || !stopToken) {
    return false;
  }
  if (trimmed === stopToken) {
    return true;
  }
  const withoutTrailing = trimmed.replace(/[\s*_`"'）).!?。！？]+$/u, "");
  const lower = withoutTrailing.toLowerCase();
  const token = stopToken.toLowerCase();
  if (!lower.endsWith(token)) {
    return false;
  }
  const before = lower.charAt(lower.length - token.length - 1);
  return !before || !/[a-z0-9]/i.test(before);
}

export function selectNextSpeaker(state: PolicyState): Selection {
  const rules = state.room.rules;
  const stopToken = rules.stopToken ?? DEFAULT_STOP_TOKEN;
  const maxHandoffs = Number.isFinite(rules.maxHandoffs) ? rules.maxHandoffs : DEFAULT_MAX_HANDOFFS;

  if (state.toldDone) {
    return { kind: "stop", reason: "done" };
  }
  if (state.mentionsHuman) {
    return { kind: "stop", reason: "human_mention", detail: "a member asked for human input" };
  }
  if (rules.budgetYuan !== undefined && state.totalCostYuan >= rules.budgetYuan) {
    return { kind: "stop", reason: "budget", detail: `cost ${state.totalCostYuan} reached budget ${rules.budgetYuan}` };
  }
  if (state.agentTurns >= maxHandoffs) {
    return { kind: "stop", reason: "max_handoffs", detail: `reached ${maxHandoffs} agent turns` };
  }
  if (rules.autonomy === "low" && state.agentTurns >= 1) {
    return { kind: "stop", reason: "autonomy_low", detail: "low autonomy stops after one agent turn" };
  }

  const memberById = new Map(state.room.members.map((member) => [member.id, member]));
  const allowSameSpeaker = (rules.maxConsecutiveSameSpeaker ?? 1) > state.consecutiveSameSpeaker;

  for (const memberId of state.mentionQueue) {
    if (memberId === state.lastSpeakerId && !allowSameSpeaker) {
      continue;
    }
    if (!canSpeak(memberById.get(memberId))) {
      continue;
    }
    return {
      kind: "speak",
      memberId,
      reason: state.mentionQueueSource === "user" ? "user_mention" : "agent_mention",
    };
  }

  const planOrder = rules.planOrder?.filter((memberId) => canSpeak(memberById.get(memberId))) ?? [];
  if (planOrder.length > 0) {
    const lastIndex = state.lastSpeakerId ? planOrder.indexOf(state.lastSpeakerId) : -1;
    for (let offset = 1; offset <= planOrder.length; offset += 1) {
      const memberId = planOrder[(lastIndex + offset + planOrder.length) % planOrder.length];
      if (memberId === state.lastSpeakerId && !allowSameSpeaker) {
        continue;
      }
      return { kind: "speak", memberId, reason: "plan_order" };
    }
  }

  const candidates = state.room.members.filter((member) => {
    if (!canSpeak(member)) {
      return false;
    }
    if (state.agentTurns === 0 && member.behavior?.canInitiate === false) {
      return false;
    }
    return allowSameSpeaker || member.id !== state.lastSpeakerId;
  });
  const fresh = candidates.filter((member) => (state.turnsSinceHuman[member.id] ?? 0) === 0);
  const pool = fresh.length > 0 ? fresh : candidates;
  if (pool.length === 0) {
    return { kind: "stop", reason: "no_eligible_speaker", detail: `nobody can speak next (${stopToken})` };
  }

  const order = new Map(state.room.members.map((member, index) => [member.id, index]));
  const sorted = [...pool].sort((left, right) => {
    const weightDelta = (right.behavior?.weight ?? 1) - (left.behavior?.weight ?? 1);
    if (weightDelta !== 0) {
      return weightDelta;
    }
    const turnDelta = (state.totalTurnsByMember[left.id] ?? 0) - (state.totalTurnsByMember[right.id] ?? 0);
    if (turnDelta !== 0) {
      return turnDelta;
    }
    return (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0);
  });

  return { kind: "speak", memberId: sorted[0].id, reason: "fairness" };
}

function canSpeak(member: RoomMember | undefined): member is RoomMember {
  if (!member) {
    return false;
  }
  return (member.behavior?.weight ?? 1) > 0;
}
