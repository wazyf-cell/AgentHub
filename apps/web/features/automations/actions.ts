"use server";

import {
  createAndDispatchCollaborationRunSync,
  createAutomationRuleSync,
  updateAutomationRuleSync,
  toggleAutomationRuleSync,
  deleteAutomationRuleSync,
  stopAutoContinuationSync,
} from "@agent-space/services";
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
