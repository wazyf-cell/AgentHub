import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { enqueueNativeTaskSync } from "./task-queue.ts";
import type {
  CollaborationRunEventRecord,
  CollaborationRunRecord,
  CollaborationRunStatus,
  CollaborationTaskNodeRecord,
  CollaborationTaskNodeStatus,
} from "./types.ts";

export interface CreateCollaborationTaskNodeInput {
  id?: string;
  agentId: string;
  title: string;
  instruction: string;
  dependsOnNodeIds?: string[];
  sortOrder?: number;
}

export interface CreateCollaborationRunInput {
  id?: string;
  workspaceId?: string;
  title: string;
  goal: string;
  plan?: Record<string, unknown>;
  createdByUserId?: string;
  createdByDisplayName?: string;
  status?: Extract<CollaborationRunStatus, "draft" | "approved" | "running">;
  nodes: CreateCollaborationTaskNodeInput[];
}

export function createCollaborationRunSync(input: CreateCollaborationRunInput): {
  run: CollaborationRunRecord;
  nodes: CollaborationTaskNodeRecord[];
} {
  if (input.nodes.length === 0) {
    throw new Error("Collaboration run requires at least one task node.");
  }

  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const runId = input.id ?? `collab-run-${randomLikeId()}`;
  const status = input.status ?? "approved";
  const nodeIds = input.nodes.map((node) => node.id ?? `collab-node-${randomLikeId()}`);
  const validNodeIds = new Set(nodeIds);

  for (const [index, node] of input.nodes.entries()) {
    for (const dependencyId of node.dependsOnNodeIds ?? []) {
      if (!validNodeIds.has(dependencyId)) {
        throw new Error(`Collaboration task node "${nodeIds[index]}" depends on unknown node "${dependencyId}".`);
      }
      if (dependencyId === nodeIds[index]) {
        throw new Error(`Collaboration task node "${nodeIds[index]}" cannot depend on itself.`);
      }
    }
  }
  assertAcyclicNodeGraph(nodeIds, input.nodes.map((node) => node.dependsOnNodeIds ?? []));

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO collaboration_run (
        id,
        workspace_id,
        title,
        goal,
        status,
        plan_json,
        result_json,
        created_by_user_id,
        created_by_display_name,
        approved_at,
        finished_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      runId,
      workspaceId,
      input.title,
      input.goal,
      status,
      JSON.stringify(input.plan ?? {}),
      input.createdByUserId ?? null,
      input.createdByDisplayName ?? null,
      status === "approved" || status === "running" ? now : null,
      now,
      now,
    );

    for (const [index, node] of input.nodes.entries()) {
      const dependsOnNodeIds = node.dependsOnNodeIds ?? [];
      const nodeStatus: CollaborationTaskNodeStatus =
        status === "draft" ? "pending" : dependsOnNodeIds.length === 0 ? "ready" : "pending";
      db.prepare(
        `INSERT INTO collaboration_task_node (
          id,
          workspace_id,
          run_id,
          agent_id,
          title,
          instruction,
          depends_on_node_ids_json,
          status,
          task_queue_id,
          result_json,
          error_text,
          sort_order,
          queued_at,
          started_at,
          finished_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        nodeIds[index],
        workspaceId,
        runId,
        node.agentId,
        node.title,
        node.instruction,
        JSON.stringify(dependsOnNodeIds),
        nodeStatus,
        node.sortOrder ?? index,
        now,
        now,
      );
    }

    recordCollaborationRunEventInTransaction({
      workspaceId,
      runId,
      type: "run.created",
      summary: input.title,
      data: {
        nodeCount: input.nodes.length,
        status,
      },
      createdAt: now,
    });
  });

  const run = readCollaborationRunSync(runId, workspaceId);
  if (!run) {
    throw new Error(`Collaboration run "${runId}" could not be read after write.`);
  }
  return {
    run,
    nodes: listCollaborationTaskNodesSync(runId, workspaceId),
  };
}

export function listCollaborationRunsSync(options: {
  workspaceId?: string;
  status?: CollaborationRunStatus;
} = {}): CollaborationRunRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      title,
      goal,
      status,
      plan_json AS planJson,
      result_json AS resultJson,
      created_by_user_id AS createdByUserId,
      created_by_display_name AS createdByDisplayName,
      approved_at AS approvedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM collaboration_run
     WHERE workspace_id = ?
       AND (? IS NULL OR status = ?)
     ORDER BY updated_at DESC, created_at DESC`,
  ).all(workspaceId, options.status ?? null, options.status ?? null) as Array<Record<string, unknown>>;

  return rows.map(mapCollaborationRunRecord).filter((run): run is CollaborationRunRecord => run !== null);
}

export function readCollaborationRunSync(
  runId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationRunRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      title,
      goal,
      status,
      plan_json AS planJson,
      result_json AS resultJson,
      created_by_user_id AS createdByUserId,
      created_by_display_name AS createdByDisplayName,
      approved_at AS approvedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM collaboration_run
     WHERE workspace_id = ? AND id = ?
     LIMIT 1`,
  ).get(workspaceId, runId) as Record<string, unknown> | undefined;
  return row ? mapCollaborationRunRecord(row) : null;
}

export function listCollaborationTaskNodesSync(
  runId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationTaskNodeRecord[] {
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      run_id AS runId,
      agent_id AS agentId,
      title,
      instruction,
      depends_on_node_ids_json AS dependsOnNodeIdsJson,
      status,
      task_queue_id AS taskQueueId,
      result_json AS resultJson,
      error_text AS errorText,
      sort_order AS sortOrder,
      queued_at AS queuedAt,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM collaboration_task_node
     WHERE workspace_id = ? AND run_id = ?
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
  ).all(workspaceId, runId) as Array<Record<string, unknown>>;

  return rows.map(mapCollaborationTaskNodeRecord).filter((node): node is CollaborationTaskNodeRecord => node !== null);
}

export function readCollaborationTaskNodeSync(
  nodeId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationTaskNodeRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      run_id AS runId,
      agent_id AS agentId,
      title,
      instruction,
      depends_on_node_ids_json AS dependsOnNodeIdsJson,
      status,
      task_queue_id AS taskQueueId,
      result_json AS resultJson,
      error_text AS errorText,
      sort_order AS sortOrder,
      queued_at AS queuedAt,
      started_at AS startedAt,
      finished_at AS finishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
     FROM collaboration_task_node
     WHERE workspace_id = ? AND id = ?
     LIMIT 1`,
  ).get(workspaceId, nodeId) as Record<string, unknown> | undefined;
  return row ? mapCollaborationTaskNodeRecord(row) : null;
}

export function listReadyCollaborationTaskNodesSync(
  runId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationTaskNodeRecord[] {
  return listCollaborationTaskNodesSync(runId, workspaceId).filter((node) => node.status === "ready");
}

export function queueCollaborationTaskNodeSync(input: {
  nodeId: string;
  workspaceId?: string;
  priority?: "low" | "medium" | "high";
  requestedByUserId?: string;
  requestedByDisplayName?: string;
}): { node: CollaborationTaskNodeRecord; taskQueueId: string } | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const node = readCollaborationTaskNodeSync(input.nodeId, workspaceId);
  if (!node) {
    throw new Error(`Collaboration task node "${input.nodeId}" does not exist.`);
  }
  if (node.status !== "ready") {
    throw new Error(`Collaboration task node "${node.id}" is not ready.`);
  }
  const run = readCollaborationRunSync(node.runId, workspaceId);
  if (!run) {
    throw new Error(`Collaboration run "${node.runId}" does not exist.`);
  }

  const queued = enqueueNativeTaskSync({
    workspaceId,
    assignee: node.agentId,
    title: node.title,
    priority: input.priority ?? "medium",
    triggerType: "manual",
    requestedByUserId: input.requestedByUserId,
    requestedByDisplayName: input.requestedByDisplayName,
    metadata: {
      orchestrationRunId: run.id,
      orchestrationStepId: node.id,
      collaborationRunId: run.id,
      collaborationNodeId: node.id,
      goal: run.goal,
      stepInstruction: node.instruction,
      stepDependsOnIds: parseStringArray(node.dependsOnNodeIdsJson),
    },
  });
  if (!queued) {
    return null;
  }

  const updated = markCollaborationTaskNodeQueuedSync({
    nodeId: node.id,
    taskQueueId: queued.id,
    workspaceId,
  });
  return {
    node: updated,
    taskQueueId: queued.id,
  };
}

export function markCollaborationTaskNodeQueuedSync(input: {
  nodeId: string;
  taskQueueId: string;
  workspaceId?: string;
}): CollaborationTaskNodeRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const db = getDatabase();
  withTransaction(db, () => {
    const result = db.prepare(
      `UPDATE collaboration_task_node
       SET status = 'queued',
           task_queue_id = ?,
           queued_at = COALESCE(queued_at, ?),
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND status = 'ready'`,
    ).run(input.taskQueueId, now, now, workspaceId, input.nodeId);
    if (result.changes !== 1) {
      throw new Error(`Collaboration task node "${input.nodeId}" is not ready.`);
    }
    const node = readCollaborationTaskNodeSync(input.nodeId, workspaceId);
    if (!node) {
      throw new Error(`Collaboration task node "${input.nodeId}" does not exist.`);
    }
    db.prepare(
      `UPDATE collaboration_run
       SET status = 'running',
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND status IN ('approved', 'running')`,
    ).run(now, workspaceId, node.runId);
    recordCollaborationRunEventInTransaction({
      workspaceId,
      runId: node.runId,
      nodeId: node.id,
      type: "node.queued",
      summary: node.title,
      data: { taskQueueId: input.taskQueueId },
      createdAt: now,
    });
  });
  return readRequiredCollaborationTaskNode(input.nodeId, workspaceId);
}

export function markCollaborationTaskNodeRunningSync(input: {
  nodeId: string;
  workspaceId?: string;
}): CollaborationTaskNodeRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const db = getDatabase();
  const result = db.prepare(
    `UPDATE collaboration_task_node
     SET status = 'running',
         started_at = COALESCE(started_at, ?),
         updated_at = ?
     WHERE workspace_id = ?
       AND id = ?
       AND status IN ('queued', 'running')`,
  ).run(now, now, workspaceId, input.nodeId);
  if (result.changes !== 1) {
    throw new Error(`Collaboration task node "${input.nodeId}" cannot be marked running.`);
  }
  return readRequiredCollaborationTaskNode(input.nodeId, workspaceId);
}

export function completeCollaborationTaskNodeSync(input: {
  nodeId: string;
  workspaceId?: string;
  result?: Record<string, unknown>;
}): {
  node: CollaborationTaskNodeRecord;
  run: CollaborationRunRecord;
  readyNodes: CollaborationTaskNodeRecord[];
} {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const db = getDatabase();
  let runId = "";
  withTransaction(db, () => {
    const node = readRequiredCollaborationTaskNode(input.nodeId, workspaceId);
    runId = node.runId;
    const result = db.prepare(
      `UPDATE collaboration_task_node
       SET status = 'completed',
           result_json = ?,
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND status IN ('ready', 'queued', 'running', 'completed')`,
    ).run(input.result ? JSON.stringify(input.result) : null, now, now, workspaceId, input.nodeId);
    if (result.changes !== 1) {
      throw new Error(`Collaboration task node "${input.nodeId}" cannot be completed.`);
    }
    updateReadyNodesInTransaction(workspaceId, runId, now);
    updateRunTerminalStateInTransaction(workspaceId, runId, now, input.result);
    recordCollaborationRunEventInTransaction({
      workspaceId,
      runId,
      nodeId: input.nodeId,
      type: "node.completed",
      summary: node.title,
      data: input.result ?? {},
      createdAt: now,
    });
  });
  return {
    node: readRequiredCollaborationTaskNode(input.nodeId, workspaceId),
    run: readRequiredCollaborationRun(runId, workspaceId),
    readyNodes: listReadyCollaborationTaskNodesSync(runId, workspaceId),
  };
}

export function failCollaborationTaskNodeSync(input: {
  nodeId: string;
  workspaceId?: string;
  errorText: string;
}): {
  node: CollaborationTaskNodeRecord;
  run: CollaborationRunRecord;
  blockedNodes: CollaborationTaskNodeRecord[];
} {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const db = getDatabase();
  let runId = "";
  withTransaction(db, () => {
    const node = readRequiredCollaborationTaskNode(input.nodeId, workspaceId);
    runId = node.runId;
    db.prepare(
      `UPDATE collaboration_task_node
       SET status = 'failed',
           error_text = ?,
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND status <> 'completed'`,
    ).run(input.errorText, now, now, workspaceId, input.nodeId);
    blockDependentNodesInTransaction(workspaceId, runId, input.nodeId, now, input.errorText);
    db.prepare(
      `UPDATE collaboration_run
       SET status = 'failed',
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(now, now, workspaceId, runId);
    recordCollaborationRunEventInTransaction({
      workspaceId,
      runId,
      nodeId: input.nodeId,
      type: "node.failed",
      summary: node.title,
      data: { errorText: input.errorText },
      createdAt: now,
    });
  });
  const nodes = listCollaborationTaskNodesSync(runId, workspaceId);
  return {
    node: readRequiredCollaborationTaskNode(input.nodeId, workspaceId),
    run: readRequiredCollaborationRun(runId, workspaceId),
    blockedNodes: nodes.filter((node) => node.status === "blocked"),
  };
}

export function listCollaborationRunEventsSync(
  runId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationRunEventRecord[] {
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      run_id AS runId,
      node_id AS nodeId,
      type,
      summary,
      data_json AS dataJson,
      created_at AS createdAt
     FROM collaboration_run_event
     WHERE workspace_id = ? AND run_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(workspaceId, runId) as Array<Record<string, unknown>>;

  return rows.map(mapCollaborationRunEventRecord).filter((event): event is CollaborationRunEventRecord => event !== null);
}

function updateReadyNodesInTransaction(workspaceId: string, runId: string, now: string): void {
  const nodes = listCollaborationTaskNodesSync(runId, workspaceId);
  const completed = new Set(nodes.filter((node) => node.status === "completed").map((node) => node.id));
  for (const node of nodes) {
    if (node.status !== "pending") {
      continue;
    }
    const dependencies = parseStringArray(node.dependsOnNodeIdsJson);
    if (dependencies.every((dependencyId) => completed.has(dependencyId))) {
      getDatabase().prepare(
        `UPDATE collaboration_task_node
         SET status = 'ready',
             updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'pending'`,
      ).run(now, workspaceId, node.id);
    }
  }
}

function updateRunTerminalStateInTransaction(
  workspaceId: string,
  runId: string,
  now: string,
  result?: Record<string, unknown>,
): void {
  const nodes = listCollaborationTaskNodesSync(runId, workspaceId);
  if (nodes.length > 0 && nodes.every((node) => node.status === "completed")) {
    getDatabase().prepare(
      `UPDATE collaboration_run
       SET status = 'completed',
           result_json = ?,
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(result ? JSON.stringify(result) : null, now, now, workspaceId, runId);
    return;
  }
  getDatabase().prepare(
    `UPDATE collaboration_run
     SET status = CASE WHEN status = 'approved' THEN 'running' ELSE status END,
         updated_at = ?
     WHERE workspace_id = ? AND id = ?`,
  ).run(now, workspaceId, runId);
}

function blockDependentNodesInTransaction(
  workspaceId: string,
  runId: string,
  failedNodeId: string,
  now: string,
  errorText: string,
): void {
  const nodes = listCollaborationTaskNodesSync(runId, workspaceId);
  const blocked = new Set<string>([failedNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (blocked.has(node.id)) {
        continue;
      }
      if (parseStringArray(node.dependsOnNodeIdsJson).some((dependencyId) => blocked.has(dependencyId))) {
        blocked.add(node.id);
        changed = true;
      }
    }
  }

  for (const nodeId of blocked) {
    if (nodeId === failedNodeId) {
      continue;
    }
    getDatabase().prepare(
      `UPDATE collaboration_task_node
       SET status = 'blocked',
           error_text = COALESCE(error_text, ?),
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND status IN ('pending', 'ready', 'queued')`,
    ).run(`Blocked by failed dependency "${failedNodeId}": ${errorText}`, now, workspaceId, nodeId);
  }
}

function recordCollaborationRunEventInTransaction(input: {
  workspaceId: string;
  runId: string;
  nodeId?: string;
  type: string;
  summary?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}): void {
  getDatabase().prepare(
    `INSERT INTO collaboration_run_event (
      id,
      workspace_id,
      run_id,
      node_id,
      type,
      summary,
      data_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `collab-event-${randomLikeId()}`,
    input.workspaceId,
    input.runId,
    input.nodeId ?? null,
    input.type,
    input.summary ?? null,
    JSON.stringify(input.data ?? {}),
    input.createdAt,
  );
}

function assertAcyclicNodeGraph(nodeIds: string[], dependencies: string[][]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dependencyMap = new Map(nodeIds.map((id, index) => [id, dependencies[index] ?? []]));

  const visit = (nodeId: string): void => {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      throw new Error(`Collaboration task graph contains a cycle at node "${nodeId}".`);
    }
    visiting.add(nodeId);
    for (const dependencyId of dependencyMap.get(nodeId) ?? []) {
      visit(dependencyId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const nodeId of nodeIds) {
    visit(nodeId);
  }
}

function readRequiredCollaborationRun(runId: string, workspaceId: string): CollaborationRunRecord {
  const run = readCollaborationRunSync(runId, workspaceId);
  if (!run) {
    throw new Error(`Collaboration run "${runId}" does not exist.`);
  }
  return run;
}

function readRequiredCollaborationTaskNode(nodeId: string, workspaceId: string): CollaborationTaskNodeRecord {
  const node = readCollaborationTaskNodeSync(nodeId, workspaceId);
  if (!node) {
    throw new Error(`Collaboration task node "${nodeId}" does not exist.`);
  }
  return node;
}

function mapCollaborationRunRecord(row: Record<string, unknown>): CollaborationRunRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.title !== "string" ||
    typeof row.goal !== "string" ||
    !isCollaborationRunStatus(row.status) ||
    typeof row.planJson !== "string" ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    goal: row.goal,
    status: row.status,
    planJson: row.planJson,
    resultJson: typeof row.resultJson === "string" ? row.resultJson : undefined,
    createdByUserId: typeof row.createdByUserId === "string" ? row.createdByUserId : undefined,
    createdByDisplayName: typeof row.createdByDisplayName === "string" ? row.createdByDisplayName : undefined,
    approvedAt: typeof row.approvedAt === "string" ? row.approvedAt : undefined,
    finishedAt: typeof row.finishedAt === "string" ? row.finishedAt : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCollaborationTaskNodeRecord(row: Record<string, unknown>): CollaborationTaskNodeRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.runId !== "string" ||
    typeof row.agentId !== "string" ||
    typeof row.title !== "string" ||
    typeof row.instruction !== "string" ||
    typeof row.dependsOnNodeIdsJson !== "string" ||
    !isCollaborationTaskNodeStatus(row.status) ||
    typeof row.sortOrder !== "number" ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    agentId: row.agentId,
    title: row.title,
    instruction: row.instruction,
    dependsOnNodeIdsJson: row.dependsOnNodeIdsJson,
    status: row.status,
    taskQueueId: typeof row.taskQueueId === "string" ? row.taskQueueId : undefined,
    resultJson: typeof row.resultJson === "string" ? row.resultJson : undefined,
    errorText: typeof row.errorText === "string" ? row.errorText : undefined,
    sortOrder: row.sortOrder,
    queuedAt: typeof row.queuedAt === "string" ? row.queuedAt : undefined,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : undefined,
    finishedAt: typeof row.finishedAt === "string" ? row.finishedAt : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapCollaborationRunEventRecord(row: Record<string, unknown>): CollaborationRunEventRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.runId !== "string" ||
    typeof row.type !== "string" ||
    typeof row.dataJson !== "string" ||
    typeof row.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId,
    nodeId: typeof row.nodeId === "string" ? row.nodeId : undefined,
    type: row.type,
    summary: typeof row.summary === "string" ? row.summary : undefined,
    dataJson: row.dataJson,
    createdAt: row.createdAt,
  };
}

function isCollaborationRunStatus(value: unknown): value is CollaborationRunStatus {
  return value === "draft" || value === "approved" || value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function isCollaborationTaskNodeStatus(value: unknown): value is CollaborationTaskNodeStatus {
  return value === "pending" ||
    value === "ready" ||
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked" ||
    value === "cancelled";
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
