"use server";

import {
  createAndDispatchCollaborationRunSync,
  createAutomationRuleSync,
  markCodeDevelopmentSessionBlockedSync,
  markCodeDevelopmentSessionMergedSync,
  recordCodeDevelopmentMergePreflightSync,
  recordCodeDevelopmentPatchManifestSync,
  recordCodeDevelopmentWorktreeMergePreflightSync,
  recordCodeDevelopmentWorktreePatchManifestSync,
  reviewCodeDevelopmentPatchSync,
  updateAutomationRuleSync,
  toggleAutomationRuleSync,
  deleteAutomationRuleSync,
  stopAutoContinuationSync,
} from "@agent-space/services";
import type {
  CodeDevelopmentPatchFileChangeType,
  CodeDevelopmentPatchReviewStatus,
} from "@agent-space/domain";
import type { AutomationTrigger, AutomationCondition, AutomationAction } from "@agent-space/domain/workspace";
import { requireCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";
import { revalidateWorkspacePath, revalidateWorkspacePaths } from "@/features/auth/workspace-revalidation";

export async function createCodeDevelopmentCollaborationRunAction(input: {
  title: string;
  goal: string;
  agentId: string;
  instruction: string;
  repositoryRoot: string;
  worktreeRoot?: string;
  branchPrefix?: string;
  branchName?: string;
  baseRef?: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  const title = input.title.trim();
  const goal = input.goal.trim();
  const agentId = input.agentId.trim();
  const instruction = input.instruction.trim();
  const repositoryRoot = input.repositoryRoot.trim();
  if (!title || !goal || !agentId || !instruction || !repositoryRoot) {
    throw new Error("title, goal, agentId, instruction, and repositoryRoot are required.");
  }

  createAndDispatchCollaborationRunSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    title,
    goal,
    priority: "high",
    nodes: [
      {
        id: "code-development-1",
        agentId,
        title,
        instruction,
        codeDevelopment: {
          repositoryRoot,
          worktreeRoot: trimOptional(input.worktreeRoot),
          branchPrefix: trimOptional(input.branchPrefix),
          branchName: trimOptional(input.branchName),
          baseRef: trimOptional(input.baseRef),
          title,
          goal: instruction,
          assignedAgentIds: [agentId],
        },
      },
    ],
    createdByUserId: workspaceContext.currentUser.id,
    createdByDisplayName: workspaceContext.currentUser.displayName,
    requestedByUserId: workspaceContext.currentUser.id,
    requestedByDisplayName: workspaceContext.currentUser.displayName,
  });
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function recordCodeDevelopmentPatchManifestAction(input: {
  sessionId: string;
  summary: string;
  fileChanges: Array<{
    path: string;
    changeType?: CodeDevelopmentPatchFileChangeType;
    additions?: number;
    deletions?: number;
    previousPath?: string;
  }>;
  patchRef?: string;
  patchText?: string;
  baseRef?: string;
  headRef?: string;
  riskNotes?: string[];
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  recordCodeDevelopmentPatchManifestSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    summary: requireTrimmed(input.summary, "summary"),
    fileChanges: input.fileChanges.map((change) => ({
      path: requireTrimmed(change.path, "fileChanges.path"),
      changeType: change.changeType ?? "modified",
      additions: change.additions,
      deletions: change.deletions,
      previousPath: trimOptional(change.previousPath),
    })),
    patchRef: trimOptional(input.patchRef),
    patchText: input.patchText,
    baseRef: trimOptional(input.baseRef),
    headRef: trimOptional(input.headRef),
    riskNotes: input.riskNotes ?? [],
    createdBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function recordCodeDevelopmentWorktreePatchManifestAction(input: {
  sessionId: string;
  summary?: string;
  baseRef?: string;
  headRef?: string;
  riskNotes?: string[];
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  recordCodeDevelopmentWorktreePatchManifestSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    summary: trimOptional(input.summary),
    baseRef: trimOptional(input.baseRef),
    headRef: trimOptional(input.headRef),
    riskNotes: input.riskNotes ?? [],
    createdBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function recordCodeDevelopmentMergePreflightAction(input: {
  sessionId: string;
  targetBranch: string;
  checkedFiles?: string[];
  conflictFiles?: string[];
  warnings?: string[];
  recommendation?: string;
  baseRef?: string;
  headRef?: string;
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  recordCodeDevelopmentMergePreflightSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    targetBranch: requireTrimmed(input.targetBranch, "targetBranch"),
    checkedFiles: input.checkedFiles ?? [],
    conflictFiles: input.conflictFiles ?? [],
    warnings: input.warnings ?? [],
    recommendation: trimOptional(input.recommendation),
    baseRef: trimOptional(input.baseRef),
    headRef: trimOptional(input.headRef),
    checkedBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function recordCodeDevelopmentWorktreeMergePreflightAction(input: {
  sessionId: string;
  targetBranch?: string;
  baseRef?: string;
  headRef?: string;
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  recordCodeDevelopmentWorktreeMergePreflightSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    targetBranch: trimOptional(input.targetBranch),
    baseRef: trimOptional(input.baseRef),
    headRef: trimOptional(input.headRef),
    checkedBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function reviewCodeDevelopmentPatchAction(input: {
  sessionId: string;
  status: CodeDevelopmentPatchReviewStatus;
  comment?: string;
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  reviewCodeDevelopmentPatchSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    status: input.status,
    comment: trimOptional(input.comment),
    reviewer: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function markCodeDevelopmentSessionMergedAction(input: {
  sessionId: string;
  notes?: string;
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  markCodeDevelopmentSessionMergedSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    notes: trimOptional(input.notes),
    mergedBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function markCodeDevelopmentSessionBlockedAction(input: {
  sessionId: string;
  reason: string;
}): Promise<void> {
  const workspaceContext = await requireCodeDevelopmentAdminContext();
  markCodeDevelopmentSessionBlockedSync({
    sessionId: requireTrimmed(input.sessionId, "sessionId"),
    reason: requireTrimmed(input.reason, "reason"),
    blockedBy: {
      type: "human",
      id: workspaceContext.currentUser.id,
    },
  }, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function createAutomationRuleAction(input: {
  name: string;
  description?: string;
  trigger: AutomationTrigger;
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  createAutomationRuleSync(input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function updateAutomationRuleAction(
  id: string,
  input: {
    name?: string;
    description?: string;
    trigger?: AutomationTrigger;
    conditions?: AutomationCondition[];
    actions?: AutomationAction[];
  },
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  updateAutomationRuleSync(id, input, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function toggleAutomationRuleAction(
  id: string,
  enabled: boolean,
): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  toggleAutomationRuleSync(id, enabled, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function deleteAutomationRuleAction(id: string): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  deleteAutomationRuleSync(id, workspaceContext.currentWorkspace.id);
  revalidateWorkspacePath("/automations", workspaceContext.currentWorkspace.slug);
}

export async function stopAutoContinuationAction(input: {
  channelName: string;
  agentId: string;
  contactId?: string;
}): Promise<void> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "member");
  stopAutoContinuationSync({
    channelName: input.channelName,
    agentId: input.agentId,
    contactId: input.contactId,
    workspaceId: workspaceContext.currentWorkspace.id,
    requestedByDisplayName: workspaceContext.currentUser.displayName.trim() || "你",
  });
  revalidateWorkspacePaths(workspaceContext.currentWorkspace.slug, ["/automations", "/im", "/inbox", "/agents"]);
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function requireCodeDevelopmentAdminContext(): Promise<Awaited<ReturnType<typeof requireCurrentWorkspaceContext>>> {
  const workspaceContext = await requireCurrentWorkspaceContext();
  assertWorkspaceRoleForContext(workspaceContext, "admin");
  return workspaceContext;
}

function requireTrimmed(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required.`);
  }
  return trimmed;
}
