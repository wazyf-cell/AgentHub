import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
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
  collaborationRunId?: string;
  collaborationNodeId?: string;
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
  collaborationRunId?: string;
  collaborationNodeId?: string;
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

export interface RecordCodeDevelopmentWorktreePatchManifestInput {
  sessionId: string;
  summary?: string;
  baseRef?: string;
  headRef?: string;
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

export interface RecordCodeDevelopmentWorktreeMergePreflightInput {
  sessionId: string;
  targetBranch?: string;
  baseRef?: string;
  headRef?: string;
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
const MAX_INLINE_UNTRACKED_PATCH_BYTES = 1024 * 1024;

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
    collaborationRunId: input.collaborationRunId?.trim() || undefined,
    collaborationNodeId: input.collaborationNodeId?.trim() || undefined,
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
      collaborationRunId: input.collaborationRunId,
      collaborationNodeId: input.collaborationNodeId,
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
    patchText: hasPatchText ? patchText : undefined,
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

export function recordCodeDevelopmentWorktreePatchManifestSync(
  input: RecordCodeDevelopmentWorktreePatchManifestInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  const worktree = validateCodeDevelopmentWorktree(session);
  const baseRef = normalizeGitRefLabel(input.baseRef?.trim() || session.baseRef || "HEAD", "baseRef");
  const baseRev = resolveGitCommit(worktree.worktreePath, baseRef, "baseRef");
  const headRef = normalizeGitRefLabel(input.headRef?.trim() || session.branchName || readGitCurrentRef(worktree.worktreePath), "headRef");
  assertWorktreeHeadMatches(worktree.worktreePath, headRef);
  const trackedPatchText = runGit(worktree.worktreePath, ["diff", "--no-ext-diff", "--binary", "--find-renames", baseRev, "--"]);
  const trackedFileChanges = readGitDiffFileChanges(worktree.worktreePath, baseRev);
  const untracked = readGitUntrackedPatchData(worktree.worktreePath);
  const fileChanges = mergePatchFileChanges([...trackedFileChanges, ...untracked.fileChanges]);
  const patchText = `${trackedPatchText}${untracked.patchText}`;
  if (fileChanges.length === 0 || patchText.trim().length === 0) {
    throw new Error(`Code development worktree "${session.worktreePath}" has no changes against "${baseRef}".`);
  }

  return recordCodeDevelopmentPatchManifestSync(
    {
      sessionId: session.id,
      summary: input.summary?.trim() || `Git diff from ${baseRef} to ${headRef}.`,
      patchText,
      baseRef,
      headRef,
      fileChanges,
      riskNotes: [...(input.riskNotes ?? []), ...untracked.warnings],
      createdBy: input.createdBy,
    },
    workspaceId,
  );
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

export function recordCodeDevelopmentWorktreeMergePreflightSync(
  input: RecordCodeDevelopmentWorktreeMergePreflightInput,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CodeDevelopmentSession {
  const state = ensureWorkspaceStateSync(workspaceId);
  const session = requireSession(state.codeDevelopmentSessions, input.sessionId);
  assertMutableSession(session);
  if (!session.patch) {
    throw new Error(`Code development session "${input.sessionId}" does not have a patch to preflight.`);
  }

  const worktree = validateCodeDevelopmentWorktree(session);
  const targetBranch = normalizeBranchName(input.targetBranch?.trim() || session.baseRef || "main");
  const baseRef = input.baseRef?.trim() || session.patch.baseRef || session.baseRef;
  const baseRev = baseRef ? resolveGitCommit(worktree.worktreePath, normalizeGitRefLabel(baseRef, "baseRef"), "baseRef") : undefined;
  const headRef = normalizeGitRefLabel(input.headRef?.trim() || session.patch.headRef || session.branchName, "headRef");
  assertWorktreeHeadMatches(worktree.worktreePath, headRef);
  const checkedFiles = session.patch.fileChanges?.map((change) => change.path) ?? session.patch.changedFiles;
  const warnings: string[] = [];
  const conflictFiles: string[] = [];

  const targetRev = tryResolveGitCommit(worktree.worktreePath, targetBranch);
  if (!targetRev.ok) {
    warnings.push(`Target branch "${targetBranch}" cannot be resolved in the worktree.`);
  }

  if (baseRev && targetRev.ok) {
    const targetChangedFiles = tryRunGit(worktree.worktreePath, [
      "diff",
      "--no-ext-diff",
      "--name-only",
      "--find-renames",
      `${baseRev}..${targetRev.rev}`,
      "--",
    ]);
    if (targetChangedFiles.ok) {
      const targetChanged = new Set(parseGitPathLines(targetChangedFiles.output));
      const overlaps = checkedFiles.filter((file) => targetChanged.has(normalizeRepositoryRelativeFilePath(file)));
      if (overlaps.length > 0) {
        conflictFiles.push(...overlaps);
        warnings.push(`Target branch changed files also touched by this patch: ${overlaps.join(", ")}`);
      }
    } else {
      warnings.push(`Unable to compare "${baseRef}" with "${targetBranch}".`);
    }
  } else if (!baseRef) {
    warnings.push("No base ref is available for target branch comparison.");
  }

  if (targetRev.ok) {
    const diffCheck = tryRunGit(worktree.worktreePath, ["diff", "--no-ext-diff", "--check", targetBranch, "--"]);
    if (!diffCheck.ok) {
      const detail = [...diffCheck.output.split(/\r?\n/), ...diffCheck.error.split(/\r?\n/)]
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
      warnings.push(detail ? `git diff --check reported issues: ${detail}` : "git diff --check reported issues.");
    }
  }

  return recordCodeDevelopmentMergePreflightSync(
    {
      sessionId: session.id,
      targetBranch,
      baseRef,
      headRef,
      checkedFiles,
      conflictFiles,
      warnings,
      recommendation: conflictFiles.length > 0
        ? "Resolve target branch file overlap before merge."
        : warnings.length > 0
          ? "Review generated warnings before merge."
          : "Generated preflight is clean. Manual merge may proceed after approved review.",
      checkedBy: input.checkedBy,
    },
    workspaceId,
  );
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

function validateCodeDevelopmentWorktree(session: CodeDevelopmentSession): {
  repositoryRoot: string;
  worktreePath: string;
  gitTopLevel: string;
} {
  const repositoryRoot = normalizeComparablePath(session.repositoryRoot);
  const worktreePath = normalizeComparablePath(session.worktreePath);
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(worktreePath)) {
    throw new Error("Code development repository root and worktree path must be absolute paths.");
  }
  if (!isExistingDirectory(repositoryRoot)) {
    throw new Error(`Code development repository root "${session.repositoryRoot}" does not exist.`);
  }
  const repositoryTopLevel = normalizeComparablePath(runGit(repositoryRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (!samePath(repositoryTopLevel, repositoryRoot)) {
    throw new Error("Code development repository root must point to the git repository root.");
  }
  if (!isPathInside(repositoryRoot, worktreePath)) {
    throw new Error("Code development worktree path must stay inside the repository root.");
  }
  if (!isExistingDirectory(worktreePath)) {
    throw new Error(`Code development worktree path "${session.worktreePath}" does not exist.`);
  }

  const isInsideWorktree = runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (isInsideWorktree !== "true") {
    throw new Error(`Code development worktree path "${session.worktreePath}" is not a git worktree.`);
  }
  const gitTopLevel = normalizeComparablePath(runGit(worktreePath, ["rev-parse", "--show-toplevel"]).trim());
  if (!samePath(gitTopLevel, worktreePath)) {
    throw new Error("Code development worktree path must point to the git worktree root.");
  }
  const repositoryCommonDir = normalizeComparablePath(runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  const worktreeCommonDir = normalizeComparablePath(runGit(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
  if (!samePath(repositoryCommonDir, worktreeCommonDir)) {
    throw new Error("Code development worktree must belong to the same git repository as repository root.");
  }
  return { repositoryRoot, worktreePath, gitTopLevel };
}

function isExistingDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: string[]): string {
  const result = tryRunGit(cwd, args);
  if (result.ok) {
    return result.output;
  }
  throw new Error(formatGitError(args, result.error || result.output));
}

function tryRunGit(cwd: string, args: string[]): { ok: true; output: string; error: string } | { ok: false; output: string; error: string } {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      error: "",
    };
  } catch (error) {
    const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      output: bufferOrStringToUtf8(failure.stdout),
      error: bufferOrStringToUtf8(failure.stderr) || failure.message || "Unknown git error.",
    };
  }
}

function bufferOrStringToUtf8(value: Buffer | string | undefined): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return value ?? "";
}

function formatGitError(args: string[], detail: string): string {
  const summary = detail.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" ");
  return `git ${args.join(" ")} failed${summary ? `: ${summary}` : "."}`;
}

function readGitCurrentRef(worktreePath: string): string {
  const branch = tryRunGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch.ok) {
    const value = branch.output.trim();
    if (value && value !== "HEAD") {
      return value;
    }
  }
  const sha = tryRunGit(worktreePath, ["rev-parse", "--short", "HEAD"]);
  return sha.ok && sha.output.trim() ? sha.output.trim() : "HEAD";
}

function normalizeGitRefLabel(value: string, fieldName: string): string {
  const ref = value.trim();
  if (!ref || ref.startsWith("-") || ref.includes("\0") || /[\r\n\t]/.test(ref)) {
    throw new Error(`Code development ${fieldName} is invalid.`);
  }
  return ref;
}

function resolveGitCommit(worktreePath: string, ref: string, fieldName: string): string {
  const result = tryResolveGitCommit(worktreePath, ref);
  if (result.ok) {
    return result.rev;
  }
  throw new Error(`Code development ${fieldName} "${ref}" cannot be resolved to a commit.`);
}

function tryResolveGitCommit(worktreePath: string, ref: string): { ok: true; rev: string } | { ok: false } {
  const normalized = normalizeGitRefLabel(ref, "ref");
  const result = tryRunGit(worktreePath, ["rev-parse", "--verify", "--end-of-options", `${normalized}^{commit}`]);
  if (!result.ok) {
    return { ok: false };
  }
  const rev = result.output.trim();
  return rev ? { ok: true, rev } : { ok: false };
}

function assertWorktreeHeadMatches(worktreePath: string, expectedHeadRef: string): void {
  const currentRef = readGitCurrentRef(worktreePath);
  if (currentRef === expectedHeadRef) {
    return;
  }
  const expected = tryResolveGitCommit(worktreePath, expectedHeadRef);
  const actual = tryResolveGitCommit(worktreePath, "HEAD");
  if (expected.ok && actual.ok && expected.rev === actual.rev) {
    return;
  }
  throw new Error(`Code development worktree is checked out at "${currentRef}", expected "${expectedHeadRef}".`);
}

function readGitDiffFileChanges(
  worktreePath: string,
  baseRef: string,
): Array<{
  path: string;
  changeType: CodeDevelopmentPatchFileChangeType;
  additions?: number;
  deletions?: number;
  previousPath?: string;
}> {
  const additionsByPath = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of runGit(worktreePath, ["diff", "--no-ext-diff", "--numstat", "--find-renames", baseRef, "--"]).split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const filePath = parseGitDiffStatPath(parts.slice(2).join("\t"));
    if (!filePath) {
      continue;
    }
    additionsByPath.set(filePath, {
      additions: parseGitDiffStatNumber(parts[0]),
      deletions: parseGitDiffStatNumber(parts[1]),
    });
  }

  const changes: Array<{
    path: string;
    changeType: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }> = [];
  for (const line of runGit(worktreePath, ["diff", "--no-ext-diff", "--name-status", "--find-renames", baseRef, "--"]).split(/\r?\n/)) {
    const parts = line.split("\t").filter((part) => part.length > 0);
    if (parts.length < 2) {
      continue;
    }
    const status = parts[0] ?? "";
    const renamed = status.startsWith("R");
    const filePath = renamed ? parts[2] : parts[1];
    if (!filePath) {
      continue;
    }
    const normalizedPath = normalizeRepositoryRelativeFilePath(filePath);
    const stats = additionsByPath.get(normalizedPath);
    changes.push({
      path: normalizedPath,
      changeType: gitStatusToPatchChangeType(status),
      additions: stats?.additions,
      deletions: stats?.deletions,
      previousPath: renamed && parts[1] ? normalizeRepositoryRelativeFilePath(parts[1]) : undefined,
    });
  }
  return changes;
}

function readGitUntrackedPatchData(
  worktreePath: string,
): {
  fileChanges: Array<{
    path: string;
    changeType: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }>;
  patchText: string;
  warnings: string[];
} {
  const fileChanges: Array<{
    path: string;
    changeType: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }> = [];
  const patches: string[] = [];
  const warnings: string[] = [];
  for (const filePath of runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
    const normalizedPath = filePath.trim() ? normalizeRepositoryRelativeFilePath(filePath) : undefined;
    if (!normalizedPath) {
      continue;
    }
    const file = readSmallRegularWorktreeFile(worktreePath, normalizedPath);
    fileChanges.push({
      path: normalizedPath,
      changeType: "added",
      additions: file.ok ? countTextLines(file.content) : undefined,
      deletions: 0,
      previousPath: undefined,
    });
    if (file.ok) {
      patches.push(formatUntrackedFilePatch(normalizedPath, file.content));
    } else {
      warnings.push(file.warning);
    }
  }
  return { fileChanges, patchText: patches.join(""), warnings };
}

function formatUntrackedFilePatch(repositoryRelativePath: string, content: Buffer): string {
  const escapedPath = escapeGitPatchPath(repositoryRelativePath);
  if (isLikelyBinary(content)) {
    return `diff --git a/${escapedPath} b/${escapedPath}\nnew file mode 100644\nBinary files /dev/null and b/${escapedPath} differ\n`;
  }
  const text = content.toString("utf8");
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${escapedPath} b/${escapedPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${escapedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    "",
  ].join("\n");
}

function readSmallRegularWorktreeFile(
  worktreePath: string,
  repositoryRelativePath: string,
): { ok: true; content: Buffer } | { ok: false; warning: string } {
  const absolutePath = path.join(worktreePath, repositoryRelativePath);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(absolutePath);
  } catch {
    return { ok: false, warning: `Untracked file disappeared before patch generation: ${repositoryRelativePath}` };
  }
  if (!stats.isFile()) {
    return { ok: false, warning: `Untracked non-regular file omitted from patch text: ${repositoryRelativePath}` };
  }
  if (stats.size > MAX_INLINE_UNTRACKED_PATCH_BYTES) {
    return { ok: false, warning: `Untracked file is larger than ${MAX_INLINE_UNTRACKED_PATCH_BYTES} bytes and was omitted from patch text: ${repositoryRelativePath}` };
  }
  return { ok: true, content: readFileSync(absolutePath) };
}

function mergePatchFileChanges(
  changes: Array<{
    path: string;
    changeType: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }>,
): Array<{
  path: string;
  changeType: CodeDevelopmentPatchFileChangeType;
  additions?: number;
  deletions?: number;
  previousPath?: string;
}> {
  const result: Array<{
    path: string;
    changeType: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }> = [];
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.path)) {
      continue;
    }
    result.push(change);
    seen.add(change.path);
  }
  return result;
}

function parseGitDiffStatPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes(" => ")) {
    return undefined;
  }
  return normalizeRepositoryRelativeFilePath(trimmed);
}

function parseGitDiffStatNumber(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

function countTextLines(content: Buffer): number | undefined {
  if (isLikelyBinary(content)) {
    return undefined;
  }
  const text = content.toString("utf8");
  if (text.length === 0) {
    return 0;
  }
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length;
}

function isLikelyBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8000)).includes(0);
}

function escapeGitPatchPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

function gitStatusToPatchChangeType(status: string): CodeDevelopmentPatchFileChangeType {
  if (status.startsWith("A")) {
    return "added";
  }
  if (status.startsWith("D")) {
    return "deleted";
  }
  if (status.startsWith("R")) {
    return "renamed";
  }
  return "modified";
}

function parseGitPathLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeRepositoryRelativeFilePath(line));
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
