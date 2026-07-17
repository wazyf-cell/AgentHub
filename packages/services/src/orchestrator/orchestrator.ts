import { randomUUID } from "node:crypto";
import {
  approveCollaborationRunSync,
  completeCollaborationTaskNodeSync,
  completeQueuedTaskSync,
  createCollaborationRunSync,
  failCollaborationTaskNodeSync,
  failQueuedTaskSync,
  listReadyCollaborationTaskNodesSync,
  queueCollaborationTaskNodeSync,
  readCollaborationRunSync,
  readCollaborationTaskNodeSync,
  type CollaborationRunRecord,
  type CollaborationTaskNodeRecord,
  type CreateCollaborationTaskNodeInput,
  type QueuedTaskRecord,
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
  synthesis?: CollaborationSynthesisNodeInput;
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

export interface CollaborationSynthesisNodeInput {
  id?: string;
  agentId: string;
  title?: string;
  instruction?: string;
}

export interface CompleteCollaborationNodeAndDispatchNextInput {
  workspaceId?: string;
  nodeId: string;
  result?: Record<string, unknown>;
  priority?: CollaborationDispatchPriority;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  maxNodes?: number;
}

export interface CompleteCollaborationNodeAndDispatchNextResult {
  node: CollaborationTaskNodeRecord;
  run: CollaborationRunRecord;
  readyNodes: CollaborationTaskNodeRecord[];
  dispatched: DispatchedCollaborationNode[];
  skipped: SkippedCollaborationNode[];
}

export interface CompleteQueuedTaskAndAdvanceCollaborationInput {
  taskId: string;
  attemptId?: string;
  leaseToken?: string;
  resultJson?: Record<string, unknown>;
  sessionId?: string;
  workDir?: string;
  priority?: CollaborationDispatchPriority;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
  maxNodes?: number;
}

export interface FailQueuedTaskAndAdvanceCollaborationInput {
  taskId: string;
  attemptId?: string;
  leaseToken?: string;
  errorText: string;
  sessionId?: string;
  workDir?: string;
  errorCode?: string;
  errorCategory?: string;
  provider?: string;
  rawProviderMessage?: string;
}

export interface QueuedTaskCollaborationAdvanceResult {
  task: QueuedTaskRecord;
  collaboration?: CompleteCollaborationNodeAndDispatchNextResult | {
    node: CollaborationTaskNodeRecord;
    run: CollaborationRunRecord;
    blockedNodes: CollaborationTaskNodeRecord[];
  };
  skippedReason?: "not_collaboration_task" | "collaboration_node_already_terminal" | "collaboration_run_already_terminal";
}

export function createCollaborationPlanDraftSync(input: CreateCollaborationPlanDraftInput): CollaborationPlanResult {
  const planNodes = preparePlanNodesWithSynthesis(input.nodes, input.synthesis);
  return createCollaborationRunSync({
    id: input.id,
    workspaceId: input.workspaceId,
    title: input.title,
    goal: input.goal,
    createdByUserId: input.createdByUserId,
    createdByDisplayName: input.createdByDisplayName,
    status: "draft",
    plan: {
      ...(input.plan ?? {}),
      review: {
        ...(readObject(input.plan?.review)),
        required: true,
      },
      synthesis: input.synthesis ? buildSynthesisPlanMetadata(planNodes, input.synthesis.id) : readObject(input.plan?.synthesis),
    },
    nodes: planNodes,
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
  const planNodes = preparePlanNodesWithSynthesis(input.nodes, input.synthesis);
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
      synthesis: input.synthesis ? buildSynthesisPlanMetadata(planNodes, input.synthesis.id) : readObject(input.plan?.synthesis),
    },
    createdByUserId: input.createdByUserId,
    createdByDisplayName: input.createdByDisplayName,
    status: "draft",
    nodes: planNodes,
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

export function completeCollaborationNodeAndDispatchNextSync(
  input: CompleteCollaborationNodeAndDispatchNextInput,
): CompleteCollaborationNodeAndDispatchNextResult {
  const existingNode = readCollaborationTaskNodeSync(input.nodeId, input.workspaceId);
  if (!existingNode) {
    throw new Error(`Collaboration task node "${input.nodeId}" does not exist.`);
  }
  const existingRun = readCollaborationRunSync(existingNode.runId, input.workspaceId);
  if (!existingRun) {
    throw new Error(`Collaboration run "${existingNode.runId}" does not exist.`);
  }
  if (isTerminalRunStatus(existingRun.status) && existingNode.status !== "completed") {
    throw new Error(`Collaboration run "${existingRun.id}" is already terminal.`);
  }
  if (existingNode.status === "completed") {
    return {
      node: existingNode,
      run: existingRun,
      readyNodes: listReadyCollaborationTaskNodesSync(existingRun.id, input.workspaceId),
      dispatched: [],
      skipped: [],
    };
  }

  const completed = completeCollaborationTaskNodeSync({
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    result: input.result,
  });

  if (isTerminalRunStatus(completed.run.status)) {
    return {
      node: completed.node,
      run: completed.run,
      readyNodes: completed.readyNodes,
      dispatched: [],
      skipped: [],
    };
  }

  const dispatch = dispatchReadyCollaborationNodesSync({
    workspaceId: input.workspaceId,
    runId: completed.run.id,
    priority: input.priority,
    requestedByUserId: input.requestedByUserId,
    requestedByDisplayName: input.requestedByDisplayName,
    maxNodes: input.maxNodes,
  });

  return {
    node: completed.node,
    run: dispatch.run,
    readyNodes: completed.readyNodes,
    dispatched: dispatch.dispatched,
    skipped: dispatch.skipped,
  };
}

export function completeQueuedTaskAndAdvanceCollaborationSync(
  input: CompleteQueuedTaskAndAdvanceCollaborationInput,
): QueuedTaskCollaborationAdvanceResult {
  const task = completeQueuedTaskSync({
    taskId: input.taskId,
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    resultJson: input.resultJson,
    sessionId: input.sessionId,
    workDir: input.workDir,
  });
  const context = readCollaborationContextFromTask(task);
  if (!context) {
    return {
      task,
      skippedReason: "not_collaboration_task",
    };
  }

  const linked = readAndValidateLinkedCollaborationNodeForBridge(task, context);
  if (!linked) {
    return {
      task,
      skippedReason: "not_collaboration_task",
    };
  }
  if (linked.node.status === "failed" || linked.node.status === "blocked" || linked.node.status === "cancelled") {
    return {
      task,
      skippedReason: "collaboration_node_already_terminal",
    };
  }
  if (isTerminalRunStatus(linked.run.status) && linked.node.status !== "completed") {
    return {
      task,
      skippedReason: "collaboration_run_already_terminal",
    };
  }

  return {
    task,
    collaboration: completeCollaborationNodeAndDispatchNextSync({
      workspaceId: task.workspaceId,
      nodeId: context.nodeId,
      result: buildCollaborationResultFromTask(task),
      priority: input.priority,
      requestedByUserId: input.requestedByUserId ?? task.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName ?? task.requestedByDisplayName,
      maxNodes: input.maxNodes,
    }),
  };
}

export function failQueuedTaskAndAdvanceCollaborationSync(
  input: FailQueuedTaskAndAdvanceCollaborationInput,
): QueuedTaskCollaborationAdvanceResult {
  const task = failQueuedTaskSync({
    taskId: input.taskId,
    attemptId: input.attemptId,
    leaseToken: input.leaseToken,
    errorText: input.errorText,
    sessionId: input.sessionId,
    workDir: input.workDir,
    errorCode: input.errorCode,
    errorCategory: input.errorCategory,
    provider: input.provider,
    rawProviderMessage: input.rawProviderMessage,
  });
  const context = readCollaborationContextFromTask(task);
  if (!context) {
    return {
      task,
      skippedReason: "not_collaboration_task",
    };
  }

  const linked = readAndValidateLinkedCollaborationNodeForBridge(task, context);
  if (!linked) {
    return {
      task,
      skippedReason: "not_collaboration_task",
    };
  }
  if (linked.node.status === "completed" || linked.node.status === "failed" || linked.node.status === "blocked" || linked.node.status === "cancelled") {
    return {
      task,
      skippedReason: "collaboration_node_already_terminal",
    };
  }
  if (isTerminalRunStatus(linked.run.status)) {
    return {
      task,
      skippedReason: "collaboration_run_already_terminal",
    };
  }

  return {
    task,
    collaboration: failCollaborationTaskNodeSync({
      workspaceId: task.workspaceId,
      nodeId: context.nodeId,
      errorText: input.errorText,
    }),
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

type LinkedCollaborationContext = {
  runId?: string;
  nodeId: string;
  source: "collaboration_node_id" | "legacy_orchestration_step_id";
};

function readCollaborationContextFromTask(task: QueuedTaskRecord): LinkedCollaborationContext | null {
  const payload = parseJsonObject(task.inputJson);
  const collaborationNodeId = readString(payload.collaborationNodeId);
  if (collaborationNodeId) {
    return {
      nodeId: collaborationNodeId,
      runId: readString(payload.collaborationRunId) ?? readString(payload.orchestrationRunId),
      source: "collaboration_node_id",
    };
  }
  const legacyStepId = readString(payload.orchestrationStepId);
  if (!legacyStepId) {
    return null;
  }
  return {
    nodeId: legacyStepId,
    runId: readString(payload.collaborationRunId) ?? readString(payload.orchestrationRunId),
    source: "legacy_orchestration_step_id",
  };
}

function readAndValidateLinkedCollaborationNodeForBridge(
  task: QueuedTaskRecord,
  context: LinkedCollaborationContext,
): { node: CollaborationTaskNodeRecord; run: CollaborationRunRecord } | null {
  try {
    const linked = readAndValidateLinkedCollaborationNode(task, context);
    if (!linked && context.source === "collaboration_node_id") {
      throw new Error(`Collaboration task node "${context.nodeId}" does not exist.`);
    }
    return linked;
  } catch (error) {
    if (context.source === "legacy_orchestration_step_id" && error instanceof CollaborationLinkValidationError) {
      return null;
    }
    throw error;
  }
}

function readAndValidateLinkedCollaborationNode(
  task: QueuedTaskRecord,
  context: LinkedCollaborationContext,
): { node: CollaborationTaskNodeRecord; run: CollaborationRunRecord } | null {
  const node = readCollaborationTaskNodeSync(context.nodeId, task.workspaceId);
  if (!node) {
    return null;
  }
  const run = readCollaborationRunSync(node.runId, task.workspaceId);
  if (!run) {
    throw new Error(`Collaboration run "${node.runId}" does not exist.`);
  }
  if (context.runId && node.runId !== context.runId) {
    throw new CollaborationLinkValidationError(`Queued task "${task.id}" points to collaboration run "${context.runId}" but node "${node.id}" belongs to "${node.runId}".`);
  }
  if (node.taskQueueId !== task.id) {
    throw new CollaborationLinkValidationError(`Queued task "${task.id}" is not linked to collaboration task node "${node.id}".`);
  }
  return { node, run };
}

class CollaborationLinkValidationError extends Error {}

function buildCollaborationResultFromTask(task: QueuedTaskRecord): Record<string, unknown> {
  return {
    ...(task.resultJson ? parseJsonObject(task.resultJson) : {}),
    taskQueueId: task.id,
    runtimeId: task.runtimeId,
    sessionId: task.sessionId,
    workDir: task.workDir,
    finishedAt: task.finishedAt,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readObject(parsed);
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function preparePlanNodesWithSynthesis(
  nodes: CreateCollaborationTaskNodeInput[],
  synthesis: CollaborationSynthesisNodeInput | undefined,
): CreateCollaborationTaskNodeInput[] {
  const normalizedNodes = nodes.map((node, index) => ({
    ...node,
    id: node.id ?? `collab-node-${randomUUID()}`,
    sortOrder: node.sortOrder ?? index,
  }));
  if (!synthesis) {
    return normalizedNodes;
  }

  const synthesisId = synthesis.id ?? `collab-node-synthesis-${randomUUID()}`;
  if (normalizedNodes.some((node) => node.id === synthesisId)) {
    throw new Error(`Synthesis node id "${synthesisId}" duplicates an existing collaboration node.`);
  }
  return [
    ...normalizedNodes,
    {
      id: synthesisId,
      agentId: synthesis.agentId,
      title: synthesis.title ?? "Synthesize collaboration result",
      instruction: synthesis.instruction ??
        "Review all completed collaboration task results and produce the final consolidated answer.",
      dependsOnNodeIds: normalizedNodes.map((node) => node.id!),
      sortOrder: normalizedNodes.length,
    },
  ];
}

function buildSynthesisPlanMetadata(
  nodes: CreateCollaborationTaskNodeInput[],
  explicitSynthesisId: string | undefined,
): Record<string, unknown> {
  const synthesisNode = explicitSynthesisId
    ? nodes.find((node) => node.id === explicitSynthesisId)
    : nodes[nodes.length - 1];
  return {
    enabled: true,
    nodeId: synthesisNode?.id,
    dependsOnNodeIds: synthesisNode?.dependsOnNodeIds ?? [],
  };
}

function isTerminalRunStatus(status: CollaborationRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
