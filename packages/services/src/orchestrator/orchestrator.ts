import {
  approveCollaborationRunSync,
  createCollaborationRunSync,
  listReadyCollaborationTaskNodesSync,
  queueCollaborationTaskNodeSync,
  readCollaborationRunSync,
  type CollaborationRunRecord,
  type CollaborationTaskNodeRecord,
  type CreateCollaborationTaskNodeInput,
} from "@agent-space/db";

export type CollaborationDispatchPriority = "low" | "medium" | "high";

export interface CreateCollaborationPlanDraftInput {
  id?: string;
  workspaceId?: string;
  title: string;
  goal: string;
  plan?: Record<string, unknown>;
  createdByUserId?: string;
  createdByDisplayName?: string;
  nodes: CreateCollaborationTaskNodeInput[];
}

export interface CollaborationPlanResult {
  run: CollaborationRunRecord;
  nodes: CollaborationTaskNodeRecord[];
}

export interface ApproveCollaborationPlanInput {
  workspaceId?: string;
  runId: string;
  approvedByUserId?: string;
  approvedByDisplayName?: string;
}

export interface ApproveCollaborationPlanResult extends CollaborationPlanResult {
  readyNodes: CollaborationTaskNodeRecord[];
}

export interface DispatchReadyCollaborationNodesInput {
  workspaceId?: string;
  runId: string;
  priority?: CollaborationDispatchPriority;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  maxNodes?: number;
}

export interface DispatchedCollaborationNode {
  node: CollaborationTaskNodeRecord;
  taskQueueId: string;
}

export interface SkippedCollaborationNode {
  node: CollaborationTaskNodeRecord;
  reason: "missing_runtime_binding";
}

export interface DispatchReadyCollaborationNodesResult {
  run: CollaborationRunRecord;
  dispatched: DispatchedCollaborationNode[];
  skipped: SkippedCollaborationNode[];
}

export interface CreateAndDispatchCollaborationRunInput extends CreateCollaborationPlanDraftInput {
  priority?: CollaborationDispatchPriority;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  maxNodes?: number;
}

export interface CreateAndDispatchCollaborationRunResult extends CollaborationPlanResult {
  dispatched: DispatchedCollaborationNode[];
  skipped: SkippedCollaborationNode[];
}

export function createCollaborationPlanDraftSync(input: CreateCollaborationPlanDraftInput): CollaborationPlanResult {
  return createCollaborationRunSync({
    ...input,
    status: "draft",
    plan: {
      ...(input.plan ?? {}),
      review: {
        ...(readObject(input.plan?.review)),
        required: true,
      },
    },
  });
}

export function approveCollaborationPlanSync(input: ApproveCollaborationPlanInput): ApproveCollaborationPlanResult {
  return approveCollaborationRunSync(input);
}

export function dispatchReadyCollaborationNodesSync(
  input: DispatchReadyCollaborationNodesInput,
): DispatchReadyCollaborationNodesResult {
  const run = readCollaborationRunSync(input.runId, input.workspaceId);
  if (!run) {
    throw new Error(`Collaboration run "${input.runId}" does not exist.`);
  }
  if (run.status === "draft") {
    throw new Error(`Collaboration run "${input.runId}" must be approved before dispatch.`);
  }
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw new Error(`Collaboration run "${input.runId}" is already terminal.`);
  }

  const readyNodes = listReadyCollaborationTaskNodesSync(input.runId, input.workspaceId);
  const limit = normalizeMaxNodes(input.maxNodes);
  const nodesToDispatch = typeof limit === "number" ? readyNodes.slice(0, limit) : readyNodes;
  const dispatched: DispatchedCollaborationNode[] = [];
  const skipped: SkippedCollaborationNode[] = [];

  for (const node of nodesToDispatch) {
    const queued = queueCollaborationTaskNodeSync({
      workspaceId: input.workspaceId,
      nodeId: node.id,
      priority: input.priority ?? "medium",
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
    });
    if (queued) {
      dispatched.push(queued);
    } else {
      skipped.push({
        node,
        reason: "missing_runtime_binding",
      });
    }
  }

  return {
    run: readCollaborationRunSync(input.runId, input.workspaceId) ?? run,
    dispatched,
    skipped,
  };
}

export function createAndDispatchCollaborationRunSync(
  input: CreateAndDispatchCollaborationRunInput,
): CreateAndDispatchCollaborationRunResult {
  const created = createCollaborationRunSync({
    id: input.id,
    workspaceId: input.workspaceId,
    title: input.title,
    goal: input.goal,
    plan: {
      ...(input.plan ?? {}),
      review: {
        ...(readObject(input.plan?.review)),
        required: false,
        mode: "auto_approved",
      },
    },
    createdByUserId: input.createdByUserId,
    createdByDisplayName: input.createdByDisplayName,
    status: "draft",
    nodes: input.nodes,
  });
  const approved = approveCollaborationPlanSync({
    workspaceId: input.workspaceId,
    runId: created.run.id,
    approvedByUserId: input.requestedByUserId ?? input.createdByUserId,
    approvedByDisplayName: input.requestedByDisplayName ?? input.createdByDisplayName,
  });
  const dispatch = dispatchReadyCollaborationNodesSync({
    workspaceId: input.workspaceId,
    runId: created.run.id,
    priority: input.priority,
    requestedByUserId: input.requestedByUserId ?? input.createdByUserId,
    requestedByDisplayName: input.requestedByDisplayName ?? input.createdByDisplayName,
    maxNodes: input.maxNodes,
  });

  return {
    run: dispatch.run,
    nodes: approved.nodes,
    dispatched: dispatch.dispatched,
    skipped: dispatch.skipped,
  };
}

function normalizeMaxNodes(maxNodes: number | undefined): number | undefined {
  if (maxNodes === undefined) {
    return undefined;
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("maxNodes must be a positive integer.");
  }
  return maxNodes;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
