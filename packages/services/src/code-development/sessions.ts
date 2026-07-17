import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_WORKSPACE_ID } from "@agent-space/db";
import type {
  CodeDevelopmentMergePreflightStatus,
  CodeDevelopmentPatchFileChange,
  CodeDevelopmentPatchFileChangeType,
  CodeDevelopmentPatchReviewStatus,
  CodeDevelopmentSession,
  CollaborationActorRef,
} from "@agent-space/domain";
import { createOpaqueId, normalizeSkillFilePath, slugify, uniqueStringValues } from "../shared/helpers.ts";
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

export interface AllocateCodeDevelopmentSessionInput {
  title: string;
  goal: string;
  repositoryRoot: string;
  worktreeRoot?: string;
  branchPrefix?: string;
  branchName?: string;
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

export interface RecordCodeDevelopmentPatchManifestInput {
  sessionId: string;
  summary: string;
  patchText?: string;
  patchRef?: string;
  baseRef?: string;
  headRef?: string;
  fileChanges: Array<{
    path: string;
    changeType?: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }>;
  riskNotes?: string[];
  createdBy: CollaborationActorRef;
}

export interface ReviewCodeDevelopmentPatchInput {
  sessionId: string;
  status: CodeDevelopmentPatchReviewStatus;
  reviewer: CollaborationActorRef;
  comment?: string;
}

export interface RecordCodeDevelopmentMergePreflightInput {
  sessionId: string;
  targetBranch: string;
  baseRef?: string;
  headRef?: string;
  checkedFiles?: string[];
  conflictFiles?: string[];
  warnings?: string[];
  recommendation?: string;
  checkedBy: CollaborationActorRef;
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
const PATCH_FILE_CHANGE_TYPES = new Set<CodeDevelopmentPatchFileChangeType>(["added", "modified", "deleted", "renamed"]);

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

export function allocateCodeDevelopmentSessionSync(
  input: AllocateCodeDevelopmentSessionInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const title = requireTrimmed(input.title, "Code development session title is required.");
  const repositoryRoot = normalizeComparablePath(
    requireTrimmed(input.repositoryRoot, "Repository root is required."),
  );
  const worktreeRoot = normalizeComparablePath(input.worktreeRoot?.trim() || `${repositoryRoot}/.worktrees`);
  if (samePath(repositoryRoot, worktreeRoot)) {
    throw new Error("Code development worktree root must not be the repository root.");
  }
  if (!isPathInside(repositoryRoot, worktreeRoot)) {
    throw new Error("Code development worktree root must stay inside the repository root.");
  }

  const suffix = createOpaqueId().replace(/[^a-z0-9-]/gi, "").slice(-8) || "session";
  const slug = slugify(title).slice(0, 48) || "code-dev";
  const branchPrefix = normalizeBranchSegment(input.branchPrefix?.trim() || "agent-space");
  const branchName = input.branchName?.trim()
    ? normalizeBranchName(input.branchName)
    : `${branchPrefix}/${slug}-${suffix}`;
  const worktreePath = normalizeComparablePath(`${worktreeRoot}/${slug}-${suffix}`);

  return createCodeDevelopmentSessionSync(
    {
      title,
      goal: input.goal,
      repositoryRoot,
      worktreePath,
      branchName,
      baseRef: input.baseRef,
      assignedAgentIds: input.assignedAgentIds,
      createdBy: input.createdBy,
    },
    workspaceId,
  );
}

export function listCodeDevelopmentSessionsSync(workspaceId = DEFAULT_WORKSPACE_ID): CodeDevelopmentSession[] {
  return ensureWorkspaceStateSync(workspaceId).codeDevelopmentSessions
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function recordCodeDevelopmentPatchManifestSync(
  input: RecordCodeDevelopmentPatchManifestInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);

  const summary = requireTrimmed(input.summary, "Code development patch summary is required.");
  const createdById = requireTrimmed(input.createdBy.id, "Code development patch creator id is required.");
  const fileChanges = normalizePatchFileChanges(input.fileChanges);
  if (fileChanges.length === 0) {
    throw new Error("Code development patch manifest must include at least one changed file.");
  }

  const hasPatchText = input.patchText !== undefined;
  const patchText = input.patchText ?? "";
  const patchSha256 = hasPatchText ? createHash("sha256").update(patchText).digest("hex") : undefined;
  const patchSizeBytes = hasPatchText ? Buffer.byteLength(patchText, "utf8") : undefined;
  const now = new Date().toISOString();
  session.patch = {
    manifestVersion: 1,
    summary,
    patchRef: input.patchRef?.trim() || undefined,
    patchSha256,
    patchSizeBytes,
    baseRef: input.baseRef?.trim() || session.baseRef,
    headRef: input.headRef?.trim() || undefined,
    changedFiles: fileChanges.map((change) => change.path),
    fileChanges,
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

export function recordCodeDevelopmentMergePreflightSync(
  input: RecordCodeDevelopmentMergePreflightInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  if (!session.patch) {
    throw new Error(`Code development session "${input.sessionId}" does not have a patch to preflight.`);
  }

  const targetBranch = normalizeBranchName(input.targetBranch);
  const checkedById = requireTrimmed(input.checkedBy.id, "Code development preflight actor id is required.");
  const checkedFiles = normalizePreflightFileList(input.checkedFiles ?? session.patch.changedFiles);
  if (checkedFiles.length === 0) {
    throw new Error("Code development merge preflight must include at least one checked file.");
  }

  const overlapFiles = findActiveOverlappingPatchFiles(state.codeDevelopmentSessions, session.id, checkedFiles);
  const conflictFiles = uniqueStringValues([
    ...normalizePreflightFileList(input.conflictFiles ?? []),
    ...overlapFiles,
  ]);
  const warnings = uniqueStringValues([
    ...(input.warnings ?? []),
    ...(overlapFiles.length > 0 ? [`Potential active session overlap: ${overlapFiles.join(", ")}`] : []),
  ]);
  const status: CodeDevelopmentMergePreflightStatus = conflictFiles.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "clean";
  const recommendation = input.recommendation?.trim()
    || (status === "clean"
      ? "Preflight is clean. Manual merge may proceed after approved review."
      : status === "warning"
        ? "Review warnings before running a clean preflight."
        : "Resolve conflicts before merge.");
  const now = new Date().toISOString();

  session.mergePreflight = {
    status,
    targetBranch,
    baseRef: input.baseRef?.trim() || session.patch.baseRef || session.baseRef,
    headRef: input.headRef?.trim() || session.patch.headRef || session.branchName,
    checkedFiles,
    conflictFiles,
    warnings,
    recommendation,
    checkedByType: input.checkedBy.type,
    checkedById,
    checkedAt: now,
  };
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
  if (session.mergePreflight?.status !== "clean") {
    throw new Error(`Code development session "${input.sessionId}" requires a clean merge preflight before merge.`);
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
  return path.resolve(value.trim()).replace(/\\/g, "/").replace(/\/+$/g, "");
}

function samePath(left: string, right: string): boolean {
  return normalizeComparablePath(left).localeCompare(normalizeComparablePath(right), "en", { sensitivity: "base" }) === 0;
}

function isPathInside(parent: string, child: string): boolean {
  const parentPath = normalizeComparablePath(parent);
  const childPath = normalizeComparablePath(child);
  if (samePath(parentPath, childPath)) {
    return false;
  }
  const parentPrefix = parentPath.endsWith("/") ? parentPath : `${parentPath}/`;
  return childPath.toLocaleLowerCase("en").startsWith(parentPrefix.toLocaleLowerCase("en"));
}

function normalizeBranchSegment(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/");
  if (!normalized || normalized.includes("..") || normalized.startsWith("-")) {
    throw new Error("Code development branch prefix is invalid.");
  }
  return normalized;
}

function normalizeBranchName(value: string): string {
  const normalized = normalizeBranchSegment(value);
  if (normalized.endsWith(".lock")) {
    throw new Error("Code development branch name is invalid.");
  }
  return normalized;
}

function normalizePatchFileChanges(
  changes: RecordCodeDevelopmentPatchManifestInput["fileChanges"],
): CodeDevelopmentPatchFileChange[] {
  if (!Array.isArray(changes)) {
    throw new Error("Code development patch manifest must include at least one changed file.");
  }

  const result: CodeDevelopmentPatchFileChange[] = [];
  const seenPaths = new Set<string>();
  for (const change of changes) {
    const path = normalizeRepositoryRelativeFilePath(change.path);
    if (seenPaths.has(path)) {
      continue;
    }
    const changeType = change.changeType ?? "modified";
    if (!PATCH_FILE_CHANGE_TYPES.has(changeType)) {
      throw new Error(`Unsupported code development file change type "${changeType}".`);
    }
    const previousPath = change.previousPath ? normalizeRepositoryRelativeFilePath(change.previousPath) : undefined;
    result.push({
      path,
      changeType,
      additions: normalizeNonNegativeInteger(change.additions),
      deletions: normalizeNonNegativeInteger(change.deletions),
      previousPath,
    });
    seenPaths.add(path);
  }
  return result;
}

function normalizePreflightFileList(files: string[]): string[] {
  if (!Array.isArray(files)) {
    return [];
  }
  return uniqueStringValues(files.map((file) => normalizeRepositoryRelativeFilePath(file)));
}

function findActiveOverlappingPatchFiles(
  sessions: CodeDevelopmentSession[],
  currentSessionId: string,
  checkedFiles: string[],
): string[] {
  const checked = new Set(checkedFiles);
  const overlaps: string[] = [];
  for (const session of sessions) {
    if (session.id === currentSessionId || TERMINAL_STATUSES.has(session.status)) {
      continue;
    }
    for (const file of session.patch?.changedFiles ?? []) {
      const normalized = normalizeRepositoryRelativeFilePath(file);
      if (checked.has(normalized)) {
        overlaps.push(normalized);
      }
    }
  }
  return uniqueStringValues(overlaps);
}

function normalizeRepositoryRelativeFilePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    throw new Error("Code development patch file path must be repository-relative.");
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new Error("Code development patch file path must not traverse outside the repository.");
  }
  return segments.join("/");
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}
