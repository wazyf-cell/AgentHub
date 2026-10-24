export type RoomAutonomy = "low" | "medium" | "high";

export type PlatformKind = "cli" | "openai-compatible" | "plugin-bridge" | "fake";

export interface PlatformConfig {
  id: string;
  name: string;
  kind: PlatformKind;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface ModelDescriptor {
  platformId: string;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutput?: number;
  input?: Array<"text" | "image">;
  thinkingLevels?: string[];
  defaultThinking?: string;
  costMultiplier?: number;
  toolCalling?: boolean;
  enabled?: boolean;
  source?: "manual" | "sync" | "import";
  notes?: string;
}

export interface RoleBinding {
  platformId: string;
  modelId: string;
  thinking?: string;
  contextBudget?: number;
  contextWindow?: number;
  fallback?: Array<{ platformId: string; modelId: string; thinking?: string }>;
}

export interface RoomMember {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  instructions: string;
  binding: RoleBinding;
  behavior?: {
    weight?: number;
    canInitiate?: boolean;
  };
  permissions?: {
    write?: boolean;
    allowedPaths?: string[];
  };
  skills?: string[];
  mcps?: string[];
}

export interface RoomRules {
  autonomy: RoomAutonomy;
  maxHandoffs: number;
  maxConsecutiveSameSpeaker?: number;
  summarizeAt?: number;
  hardStopAt?: number;
  budgetYuan?: number;
  stopToken?: string;
  planOrder?: string[];
  draftMode?: "read-only" | "drafts";
  allowTaskWrites?: boolean;
  allowAutoMerge?: boolean;
}

export interface RoomConfig {
  version: 1;
  id: string;
  name: string;
  workspace: string;
  workspaceId?: string;
  members: RoomMember[];
  rules: RoomRules;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type TurnReason =
  | "user_mention"
  | "agent_mention"
  | "plan_order"
  | "fairness"
  | "selector"
  | "continue";

export type StopReason =
  | "done"
  | "human_mention"
  | "autonomy_low"
  | "max_handoffs"
  | "budget"
  | "context_limit"
  | "no_eligible_speaker"
  | "human_stop"
  | "error";

export interface RoomEventBase {
  v: 1;
  id: string;
  ts: string;
  roomId: string;
  type: string;
}

export type RoomEvent =
  | (RoomEventBase & {
      type: "room_created";
      name: string;
    })
  | (RoomEventBase & {
      type: "room_updated";
      name?: string;
    })
  | (RoomEventBase & {
      type: "user_message";
      messageId: string;
      text: string;
      images?: string[];
    })
  | (RoomEventBase & {
      type: "turn_started";
      turnId: string;
      memberId: string;
      memberName: string;
      reason: TurnReason;
      platformId: string;
      modelId: string;
    })
  | (RoomEventBase & {
      type: "agent_delta";
      turnId: string;
      memberId: string;
      text: string;
    })
  | (RoomEventBase & {
      type: "agent_message";
      turnId: string;
      memberId: string;
      memberName: string;
      text: string;
      mentions: string[];
      mentionsHuman: boolean;
      done: boolean;
    })
  | (RoomEventBase & {
      type: "handoff";
      fromMemberId: string;
      toMemberId: string;
      reason: TurnReason;
    })
  | (RoomEventBase & {
      type: "turn_finished";
      turnId: string;
      memberId: string;
      status: "completed" | "failed";
      usage?: TokenUsage;
      costYuan?: number;
      error?: string;
    })
  | (RoomEventBase & {
      type: "binding_used";
      turnId: string;
      memberId: string;
      requested: { platformId: string; modelId: string };
      used: { platformId: string; modelId: string };
      fallbacks: Array<{ platformId: string; modelId: string; error: string }>;
    })
  | (RoomEventBase & {
      type: "summary_updated";
      path: string;
      coveredEventId?: string;
    })
  | (RoomEventBase & {
      type: "room_stopped";
      reason: StopReason;
      detail?: string;
    })
  | (RoomEventBase & {
      type: "error";
      message: string;
      turnId?: string;
    })
  | (RoomEventBase & {
      type: "task_created";
      taskId: string;
      title: string;
      status: string;
      ownerMemberId: string;
      sourceMessageId?: string;
    })
  | (RoomEventBase & {
      type: "task_updated";
      taskId: string;
      fields: string[];
    })
  | (RoomEventBase & {
      type: "task_status";
      taskId: string;
      from: string;
      to: string;
      detail?: string;
    })
  | (RoomEventBase & {
      type: "task_report";
      taskId: string;
      path: string;
      status: string;
    })
  | (RoomEventBase & {
      type: "draft_created";
      draftId: string;
      workspaceId: string;
      changes: Array<{ path: string; kind: string }>;
      drift: string[];
      draftDir: string;
    })
  | (RoomEventBase & {
      type: "pin_added";
      pinId: string;
      messageId: string;
      taskId?: string;
    });

type DraftOf<T> = T extends RoomEventBase ? Omit<T, "v" | "id" | "ts" | "roomId"> : never;

export type RoomEventDraft = DraftOf<RoomEvent>;

export interface AgentTurnRequest {
  room: RoomConfig;
  member: RoomMember;
  prompt: string;
  turnId: string;
  images?: string[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  cwd?: string;
  writeMode?: boolean;
}

export interface AgentTurnResult {
  text: string;
  status: "completed" | "failed";
  usage?: TokenUsage;
  costYuan?: number;
  error?: string;
  sessionId?: string;
  usedBinding?: { platformId: string; modelId: string };
  fallbacks?: Array<{ platformId: string; modelId: string; error: string }>;
}

export interface AgentBackend {
  readonly id: string;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;
}
