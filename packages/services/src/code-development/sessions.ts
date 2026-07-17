import { DEFAULT_WORKSPACE_ID } from "@agent-space/db";
import type {
  CodeDevelopmentPatchReviewStatus,
  CodeDevelopmentSession,
  CollaborationActorRef,
} from "@agent-space/domain";
import { createOpaqueId, normalizeSkillFilePath, uniqueStringValues } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";

export interface CreateCodeDevelopmentSessionInput {
  title: string;
  goal: string;
  repositoryRoot: string;
  worktreePath: string;
  branchName: string;
  baseRef?: string;
  assignedAgentIds: string[];
  createdBy: CollaborationActorRef;
}

export interface RecordCodeDevelopmentPatchInput {
  sessionId: string;
  summary: string;
  patchRef?: string;
  changedFiles: string[];
  riskNotes?: string[];
  createdBy: CollaborationActorRef;
}

export interface ReviewCodeDevelopmentPatchInput {
  sessionId: string;
  status: CodeDevelopmentPatchReviewStatus;
  reviewer: CollaborationActorRef;
  comment?: string;
}

export interface MarkCodeDevelopmentSessionMergedInput {
  sessionId: string;
  mergedBy: CollaborationActorRef;
  notes?: string;
}

export interface MarkCodeDevelopmentSessionBlockedInput {
  sessionId: string;
  blockedBy: CollaborationActorRef;
  reason: string;
}

const TERMINAL_STATUSES = new Set<CodeDevelopmentSession["status"]>(["merged", "blocked", "cancelled"]);
const PATCH_REVIEW_STATUSES = new Set<CodeDevelopmentPatchReviewStatus>(["approved", "rejected", "needs_revision"]);

export function createCodeDevelopmentSessionSync(
  input: CreateCodeDevelopmentSessionInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const now = new Date().toISOString();
  const title = requireTrimmed(input.title, "Code development session title is required.");
  const goal = requireTrimmed(input.goal, "Code development session goal is required.");
  const repositoryRoot = normalizeComparablePath(
    requireTrimmed(input.repositoryRoot, "Repository root is required."),
  );
  const worktreePath = normalizeComparablePath(
    requireTrimmed(input.worktreePath, "Isolated worktree path is required."),
  );
  const branchName = requireTrimmed(input.branchName, "Branch name is required.");
  const createdById = requireTrimmed(input.createdBy.id, "Code development session creator id is required.");

  if (samePath(repositoryRoot, worktreePath)) {
    throw new Error("Code development session must use an isolated worktree, not the repository root.");
  }
  if (state.codeDevelopmentSessions.some((session) => samePath(session.worktreePath, worktreePath) && !TERMINAL_STATUSES.has(session.status))) {
    throw new Error(`Active code development session already uses worktree "${worktreePath}".`);
  }

  const session: CodeDevelopmentSession = {
    id: `code-dev-${createOpaqueId()}`,
    workspaceId,
    title,
    goal,
    repositoryRoot,
    worktreePath,
    branchName,
    baseRef: input.baseRef?.trim() || undefined,
    assignedAgentIds: uniqueStringValues(input.assignedAgentIds),
    status: "planned",
    createdByType: input.createdBy.type,
    createdById,
    createdAt: now,
    updatedAt: now,
  };

  state.codeDevelopmentSessions.unshift(session);
  writeWorkspaceStateSync(state, workspaceId);
  return session;
}

export function listCodeDevelopmentSessionsSync(workspaceId = DEFAULT_WORKSPACE_ID): CodeDevelopmentSession[] {
  return ensureWorkspaceStateSync(workspaceId).codeDevelopmentSessions
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function recordCodeDevelopmentPatchSync(
  input: RecordCodeDevelopmentPatchInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);

  const summary = requireTrimmed(input.summary, "Code development patch summary is required.");
  const createdById = requireTrimmed(input.createdBy.id, "Code development patch creator id is required.");
  const changedFiles = uniqueStringValues(input.changedFiles.map((file) => normalizeSkillFilePath(file))).filter(Boolean);
  if (changedFiles.length === 0) {
    throw new Error("Code development patch must include at least one changed file.");
  }

  const now = new Date().toISOString();
  session.patch = {
    summary,
    patchRef: input.patchRef?.trim() || undefined,
    changedFiles,
    riskNotes: uniqueStringValues(input.riskNotes ?? []),
    createdByType: input.createdBy.type,
    createdById,
    createdAt: now,
  };
  session.status = "patch_ready";
  session.updatedAt = now;
  writeWorkspaceStateSync(state, workspaceId);
  return session;
}

export function reviewCodeDevelopmentPatchSync(
  input: ReviewCodeDevelopmentPatchInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  if (!session.patch) {
    throw new Error(`Code development session "${input.sessionId}" does not have a patch to review.`);
  }
  if (!PATCH_REVIEW_STATUSES.has(input.status)) {
    throw new Error(`Unsupported code development patch review status "${input.status}".`);
  }

  const reviewerId = requireTrimmed(input.reviewer.id, "Code development patch reviewer id is required.");
  const now = new Date().toISOString();
  session.patch.review = {
    status: input.status,
    reviewerType: input.reviewer.type,
    reviewerId,
    comment: input.comment?.trim() ?? "",
    reviewedAt: now,
  };
  session.status = "reviewed";
  session.updatedAt = now;
  writeWorkspaceStateSync(state, workspaceId);
  return session;
}

export function markCodeDevelopmentSessionMergedSync(
  input: MarkCodeDevelopmentSessionMergedInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  const mergedById = requireTrimmed(input.mergedBy.id, "Code development merge actor id is required.");
  if (session.patch?.review?.status !== "approved") {
    throw new Error(`Code development session "${input.sessionId}" requires an approved patch review before merge.`);
  }

  session.status = "merged";
  session.mergeNotes = input.notes?.trim() || `Merged by ${mergedById}.`;
  session.updatedAt = new Date().toISOString();
  writeWorkspaceStateSync(state, workspaceId);
  return session;
}

export function markCodeDevelopmentSessionBlockedSync(
  input: MarkCodeDevelopmentSessionBlockedInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  requireTrimmed(input.blockedBy.id, "Code development blocked actor id is required.");
  session.status = "blocked";
  session.blockedReason = requireTrimmed(input.reason, "Code development blocked reason is required.");
  session.updatedAt = new Date().toISOString();
  writeWorkspaceStateSync(state, workspaceId);
  return session;
}

function requireSession(sessions: CodeDevelopmentSession[], sessionId: string): CodeDevelopmentSession {
  const id = sessionId.trim();
  if (!id) {
    throw new Error("Code development session id is required.");
  }
  const session = sessions.find((item) => item.id === id);
  if (!session) {
    throw new Error(`Code development session "${sessionId}" does not exist.`);
  }
  return session;
}

function assertMutableSession(session: CodeDevelopmentSession): void {
  if (TERMINAL_STATUSES.has(session.status)) {
    throw new Error(`Code development session "${session.id}" is already ${session.status}.`);
  }
}

function requireTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(message);
  }
  return trimmed;
}

function normalizeComparablePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left).localeCompare(normalizeComparablePath(right), "en", { sensitivity: "base" }) === 0;
}
