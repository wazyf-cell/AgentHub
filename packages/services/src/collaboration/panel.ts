import { DEFAULT_WORKSPACE_ID } from "@agent-space/db";
import type {
  CollaborationActorRef,
  CollaborationComment,
  CollaborationCommentThreadWithComments,
  CollaborativeObjectType,
} from "@agent-space/domain";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { recordCollaborationActivitySync, appendCollaborationActivity } from "./activity.ts";
import { addCollaborationCommentSync, createCollaborationCommentThreadSync, listCollaborationCommentThreadsSync } from "./comments.ts";

export type PanelDiscussionStatus = "open" | "decided";
export type PanelOpinionStance = "support" | "concern" | "alternative" | "neutral";

export interface PanelDiscussionOpinionRecord {
  id: string;
  actorType: CollaborationActorRef["type"];
  actorId: string;
  stance: PanelOpinionStance;
  body: string;
  createdAt: string;
}

export interface PanelDiscussionDecisionRecord {
  body: string;
  decidedByType?: CollaborationActorRef["type"];
  decidedById?: string;
  decidedAt: string;
}

export interface PanelDiscussionRecord {
  id: string;
  workspaceId: string;
  objectType: CollaborativeObjectType;
  objectId: string;
  goal: string;
  status: PanelDiscussionStatus;
  participantAgentIds: string[];
  createdByType: CollaborationActorRef["type"];
  createdById: string;
  createdAt: string;
  updatedAt: string;
  opinions: PanelDiscussionOpinionRecord[];
  decision?: PanelDiscussionDecisionRecord;
}

export interface CreatePanelDiscussionInput {
  objectType: CollaborativeObjectType;
  objectId: string;
  goal: string;
  participantAgentIds: string[];
  createdBy: CollaborationActorRef;
  initialOpinion?: string;
}

export interface RecordPanelOpinionInput {
  discussionId: string;
  author: CollaborationActorRef;
  stance: PanelOpinionStance;
  body: string;
}

export interface RecordPanelDecisionInput {
  discussionId: string;
  decidedBy: CollaborationActorRef;
  body: string;
}

const PANEL_ANCHOR_KIND = "panel_discussion";
const PANEL_STANCES = new Set<PanelOpinionStance>(["support", "concern", "alternative", "neutral"]);

export function createPanelDiscussionSync(
  input: CreatePanelDiscussionInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): PanelDiscussionRecord {
  const goal = input.goal.trim();
  if (!goal) {
    throw new Error("Panel discussion goal is required.");
  }

  const participantAgentIds = normalizeParticipantAgentIds(input.participantAgentIds);
  const thread = createCollaborationCommentThreadSync(
    {
      objectType: input.objectType,
      objectId: input.objectId,
      anchor: {
        kind: PANEL_ANCHOR_KIND,
        goal,
        participantAgentIds,
        status: "open",
      },
      createdBy: input.createdBy,
      body: encodePanelOpinion("neutral", input.initialOpinion?.trim() || goal),
    },
    workspaceId,
  );

  recordCollaborationActivitySync(
    {
      objectType: thread.objectType,
      objectId: thread.objectId,
      actor: input.createdBy,
      verb: "panel.created",
      title: "Panel discussion created",
      body: goal,
      metadata: {
        discussionId: thread.id,
        participantAgentIds,
      },
    },
    workspaceId,
  );

  return mapPanelDiscussion(thread);
}

export function recordPanelOpinionSync(
  input: RecordPanelOpinionInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): PanelDiscussionOpinionRecord {
  assertPanelStance(input.stance);
  const body = input.body.trim();
  if (!body) {
    throw new Error("Panel opinion body is required.");
  }

  const thread = readPanelThread(input.discussionId, workspaceId);
  if (readPanelStatus(thread) === "decided") {
    throw new Error(`Panel discussion "${input.discussionId}" has already been decided.`);
  }

  const comment = addCollaborationCommentSync(
    {
      threadId: thread.id,
      author: input.author,
      body: encodePanelOpinion(input.stance, body),
    },
    workspaceId,
  );
  recordCollaborationActivitySync(
    {
      objectType: thread.objectType,
      objectId: thread.objectId,
      actor: input.author,
      verb: "panel.opinion_recorded",
      title: "Panel opinion recorded",
      body,
      metadata: {
        discussionId: thread.id,
        commentId: comment.id,
        stance: input.stance,
      },
    },
    workspaceId,
  );

  return {
    id: comment.id,
    actorType: comment.authorType,
    actorId: comment.authorId,
    stance: input.stance,
    body,
    createdAt: comment.createdAt,
  };
}

export function recordPanelDecisionSync(
  input: RecordPanelDecisionInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): PanelDiscussionRecord {
  const body = input.body.trim();
  if (!body) {
    throw new Error("Panel decision body is required.");
  }

  const thread = readPanelThread(input.discussionId, workspaceId);
  if (readPanelStatus(thread) === "decided") {
    throw new Error(`Panel discussion "${input.discussionId}" has already been decided.`);
  }

  const comment = addCollaborationCommentSync(
    {
      threadId: thread.id,
      author: input.decidedBy,
      body: encodePanelDecision(body),
    },
    workspaceId,
  );

  const state = ensureWorkspaceStateSync(workspaceId);
  const storedThread = state.collaborationCommentThreads.find((item) => item.id === thread.id);
  if (!storedThread || !isPanelAnchor(storedThread.anchor)) {
    throw new Error(`Panel discussion "${input.discussionId}" does not exist.`);
  }

  const now = comment.createdAt;
  storedThread.status = "resolved";
  storedThread.updatedAt = now;
  storedThread.anchor = {
    ...storedThread.anchor,
    status: "decided",
    decision: {
      body,
      decidedByType: input.decidedBy.type,
      decidedById: input.decidedBy.id.trim(),
      decidedAt: now,
    },
  };
  appendCollaborationActivity(
    state,
    {
      objectType: storedThread.objectType,
      objectId: storedThread.objectId,
      actor: input.decidedBy,
      verb: "panel.decision_recorded",
      title: "Panel decision recorded",
      body,
      metadata: {
        discussionId: storedThread.id,
        commentId: comment.id,
      },
    },
    workspaceId,
  );
  writeWorkspaceStateSync(state, workspaceId);

  return mapPanelDiscussion({
    ...storedThread,
    comments: state.collaborationComments
      .filter((item) => item.threadId === storedThread.id)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
  });
}

export function listPanelDiscussionsSync(workspaceId = DEFAULT_WORKSPACE_ID): PanelDiscussionRecord[] {
  return listCollaborationCommentThreadsSync({}, workspaceId)
    .filter((thread) => isPanelAnchor(thread.anchor))
    .map((thread) => mapPanelDiscussion(thread))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function readPanelThread(discussionId: string, workspaceId: string): CollaborationCommentThreadWithComments {
  const id = discussionId.trim();
  if (!id) {
    throw new Error("Panel discussion id is required.");
  }

  const thread = listCollaborationCommentThreadsSync({}, workspaceId).find((item) => item.id === id);
  if (!thread || !isPanelAnchor(thread.anchor)) {
    throw new Error(`Panel discussion "${discussionId}" does not exist.`);
  }
  return thread;
}

function mapPanelDiscussion(thread: CollaborationCommentThreadWithComments): PanelDiscussionRecord {
  if (!isPanelAnchor(thread.anchor)) {
    throw new Error(`Collaboration thread "${thread.id}" is not a panel discussion.`);
  }

  const decision = readPanelDecision(thread.anchor);
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    objectType: thread.objectType,
    objectId: thread.objectId,
    goal: readString(thread.anchor.goal),
    status: readPanelStatus(thread),
    participantAgentIds: readStringArray(thread.anchor.participantAgentIds),
    createdByType: thread.createdByType,
    createdById: thread.createdById,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    opinions: thread.comments.flatMap((comment) => parsePanelOpinion(comment)),
    decision,
  };
}

function parsePanelOpinion(comment: CollaborationComment): PanelDiscussionOpinionRecord[] {
  const match = comment.body.match(/^\[(support|concern|alternative|neutral)\]\s*(.*)$/s);
  if (!match) {
    return [];
  }

  return [
    {
      id: comment.id,
      actorType: comment.authorType,
      actorId: comment.authorId,
      stance: match[1] as PanelOpinionStance,
      body: match[2]?.trim() ?? "",
      createdAt: comment.createdAt,
    },
  ];
}

function readPanelDecision(anchor: Record<string, unknown>): PanelDiscussionDecisionRecord | undefined {
  const decision = anchor.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return undefined;
  }

  const candidate = decision as Record<string, unknown>;
  const body = readString(candidate.body);
  const decidedAt = readString(candidate.decidedAt);
  if (!body || !decidedAt) {
    return undefined;
  }

  const decidedByType = candidate.decidedByType;
  return {
    body,
    decidedByType:
      decidedByType === "human" || decidedByType === "agent" || decidedByType === "system" ? decidedByType : undefined,
    decidedById: readString(candidate.decidedById) || undefined,
    decidedAt,
  };
}

function readPanelStatus(thread: CollaborationCommentThreadWithComments): PanelDiscussionStatus {
  if (thread.anchor.status === "decided" || thread.status === "resolved") {
    return "decided";
  }
  return "open";
}

function isPanelAnchor(anchor: Record<string, unknown>): boolean {
  return anchor.kind === PANEL_ANCHOR_KIND;
}

function encodePanelOpinion(stance: PanelOpinionStance, body: string): string {
  assertPanelStance(stance);
  return `[${stance}] ${body.trim()}`;
}

function encodePanelDecision(body: string): string {
  return `[decision] ${body.trim()}`;
}

function assertPanelStance(stance: PanelOpinionStance): void {
  if (!PANEL_STANCES.has(stance)) {
    throw new Error(`Unsupported panel opinion stance "${stance}".`);
  }
}

function normalizeParticipantAgentIds(agentIds: string[]): string[] {
  return Array.from(new Set(agentIds.map((agentId) => agentId.trim()).filter(Boolean)));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}
