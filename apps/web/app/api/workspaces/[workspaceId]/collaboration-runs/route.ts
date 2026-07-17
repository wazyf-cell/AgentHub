import { NextResponse } from "next/server";
import {
  countCollaborationRunsSync,
  listCollaborationRunsSync,
  listCollaborationTaskNodesSync,
  type CollaborationRunRecord,
  type CollaborationTaskNodeRecord,
} from "@agent-space/db";
import {
  createAndDispatchCollaborationRunSync,
  type CollaborationCodeDevelopmentNodeInput,
  type CollaborationDispatchPriority,
} from "@agent-space/services";
import { getWorkspaceContextForIdentifier } from "@/features/auth/server-workspace";
import { assertWorkspaceRoleForContext } from "@/features/auth/workspace-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NODES_PER_REQUEST = 20;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

interface CollaborationRunApiNodeInput {
  id?: unknown;
  agentId?: unknown;
  title?: unknown;
  instruction?: unknown;
  dependsOnNodeIds?: unknown;
  codeDevelopment?: unknown;
}

interface CollaborationRunApiSynthesisInput {
  id?: unknown;
  agentId?: unknown;
  title?: unknown;
  instruction?: unknown;
}

interface CollaborationRunApiCreateBody {
  title?: unknown;
  goal?: unknown;
  nodes?: unknown;
  synthesis?: unknown;
  priority?: unknown;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await resolveWorkspaceContext(context);
  if (workspaceContext instanceof NextResponse) {
    return workspaceContext;
  }

  const requestUrl = new URL(request.url);
  const limit = normalizeLimit(requestUrl.searchParams.get("limit"));
  const workspaceId = workspaceContext.currentWorkspace.id;
  const runs = listCollaborationRunsSync({ workspaceId, limit });

  return NextResponse.json({
    totalCount: countCollaborationRunsSync({ workspaceId }),
    limit,
    runs: runs.map((run) =>
      serializeCollaborationRun(
        run,
        listCollaborationTaskNodesSync(run.id, workspaceId),
      ),
    ),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await resolveWorkspaceContext(context);
  if (workspaceContext instanceof NextResponse) {
    return workspaceContext;
  }

  try {
    assertWorkspaceRoleForContext(workspaceContext, "admin");
  } catch {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  let body: CollaborationRunApiCreateBody;
  try {
    body = await request.json() as CollaborationRunApiCreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const normalized = normalizeCreateBody(body);
  if ("error" in normalized) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }

  try {
    const created = createAndDispatchCollaborationRunSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: normalized.title,
      goal: normalized.goal,
      nodes: normalized.nodes,
      synthesis: normalized.synthesis,
      priority: normalized.priority,
      createdByUserId: workspaceContext.currentUser.id,
      createdByDisplayName: workspaceContext.currentUser.displayName,
      requestedByUserId: workspaceContext.currentUser.id,
      requestedByDisplayName: workspaceContext.currentUser.displayName,
    });
    const nodes = listCollaborationTaskNodesSync(created.run.id, workspaceContext.currentWorkspace.id);

    return NextResponse.json({
      run: serializeCollaborationRun(created.run, nodes),
      dispatched: created.dispatched.map((item) => ({
        nodeId: item.node.id,
        taskQueueId: item.taskQueueId,
      })),
      skipped: created.skipped.map((item) => ({
        nodeId: item.node.id,
        reason: item.reason,
      })),
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to create collaboration run.",
    }, { status: 400 });
  }
}

async function resolveWorkspaceContext(context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId: workspaceIdentifier } = await context.params;
  const workspaceContext = await getWorkspaceContextForIdentifier(workspaceIdentifier);
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (
    workspaceContext.currentWorkspace.id !== workspaceIdentifier &&
    workspaceContext.currentWorkspace.slug !== workspaceIdentifier
  ) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  if (workspaceContext.accessScope === "channel") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  return workspaceContext;
}

function normalizeCreateBody(body: CollaborationRunApiCreateBody):
  | {
      title: string;
      goal: string;
      nodes: Array<{
        id: string;
        agentId: string;
        title: string;
        instruction: string;
        dependsOnNodeIds?: string[];
        codeDevelopment?: CollaborationCodeDevelopmentNodeInput;
      }>;
      synthesis?: {
        id?: string;
        agentId: string;
        title?: string;
        instruction?: string;
      };
      priority?: CollaborationDispatchPriority;
    }
  | { error: string } {
  const title = readTrimmedString(body.title);
  if (!title) {
    return { error: "title is required." };
  }
  const goal = readTrimmedString(body.goal);
  if (!goal) {
    return { error: "goal is required." };
  }
  if (!Array.isArray(body.nodes)) {
    return { error: "nodes must be an array." };
  }
  if (body.nodes.length < 1 || body.nodes.length > MAX_NODES_PER_REQUEST) {
    return { error: `nodes must contain 1 to ${MAX_NODES_PER_REQUEST} items.` };
  }

  const seenNodeIds = new Set<string>();
  const nodes: Array<{
    id: string;
    agentId: string;
    title: string;
    instruction: string;
    dependsOnNodeIds?: string[];
    codeDevelopment?: CollaborationCodeDevelopmentNodeInput;
  }> = [];

  for (const [index, rawNode] of body.nodes.entries()) {
    const node = readObject(rawNode) as CollaborationRunApiNodeInput;
    const id = readTrimmedString(node.id) ?? `node-${index + 1}`;
    const agentId = readTrimmedString(node.agentId);
    const nodeTitle = readTrimmedString(node.title);
    const instruction = readTrimmedString(node.instruction);
    const dependsOnNodeIds = readStringArray(node.dependsOnNodeIds);
    const codeDevelopment = normalizeCodeDevelopmentNodeInput(node.codeDevelopment, `nodes[${index}].codeDevelopment`);
    if ("error" in codeDevelopment) {
      return codeDevelopment;
    }

    if (!agentId || !nodeTitle || !instruction) {
      return { error: `nodes[${index}] requires agentId, title, and instruction.` };
    }
    if (seenNodeIds.has(id)) {
      return { error: `Duplicate node id "${id}".` };
    }
    seenNodeIds.add(id);

    nodes.push({
      id,
      agentId,
      title: nodeTitle,
      instruction,
      dependsOnNodeIds: dependsOnNodeIds.length > 0 ? dependsOnNodeIds : undefined,
      codeDevelopment: codeDevelopment.value,
    });
  }

  for (const [index, node] of nodes.entries()) {
    for (const dependencyId of node.dependsOnNodeIds ?? []) {
      if (!seenNodeIds.has(dependencyId)) {
        return { error: `nodes[${index}] depends on unknown node "${dependencyId}".` };
      }
    }
  }

  const priority = readPriority(body.priority);
  if (body.priority !== undefined && !priority) {
    return { error: "priority must be low, medium, or high." };
  }

  const synthesis = normalizeSynthesis(body.synthesis);
  if ("error" in synthesis) {
    return synthesis;
  }

  return {
    title,
    goal,
    nodes,
    synthesis: synthesis.value,
    priority,
  };
}

function normalizeCodeDevelopmentNodeInput(
  value: unknown,
  path: string,
): { value?: CollaborationCodeDevelopmentNodeInput } | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  const raw = readObject(value);
  const repositoryRoot = readTrimmedString(raw.repositoryRoot);
  if (!repositoryRoot) {
    return { error: `${path}.repositoryRoot is required when codeDevelopment is provided.` };
  }

  const assignedAgentIds = readStringArray(raw.assignedAgentIds);
  return {
    value: {
      repositoryRoot,
      worktreeRoot: readTrimmedString(raw.worktreeRoot),
      branchPrefix: readTrimmedString(raw.branchPrefix),
      branchName: readTrimmedString(raw.branchName),
      baseRef: readTrimmedString(raw.baseRef),
      title: readTrimmedString(raw.title),
      goal: readTrimmedString(raw.goal),
      assignedAgentIds: assignedAgentIds.length > 0 ? assignedAgentIds : undefined,
    },
  };
}

function normalizeSynthesis(value: unknown):
  | { value?: { id?: string; agentId: string; title?: string; instruction?: string } }
  | { error: string } {
  if (value === undefined || value === null) {
    return {};
  }
  const raw = readObject(value) as CollaborationRunApiSynthesisInput;
  const agentId = readTrimmedString(raw.agentId);
  if (!agentId) {
    return { error: "synthesis.agentId is required when synthesis is provided." };
  }
  return {
    value: {
      id: readTrimmedString(raw.id),
      agentId,
      title: readTrimmedString(raw.title),
      instruction: readTrimmedString(raw.instruction),
    },
  };
}

function serializeCollaborationRun(run: CollaborationRunRecord, nodes: CollaborationTaskNodeRecord[]) {
  const codeDevelopmentByNodeId = readCodeDevelopmentSessionsByNodeId(run.planJson);
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    title: run.title,
    goal: run.goal,
    status: run.status,
    createdByDisplayName: run.createdByDisplayName,
    approvedAt: run.approvedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    evidenceSummary: readEvidenceSummary(run.resultJson),
    evidenceSourceCount: readEvidenceSourceCount(run.resultJson),
    evidenceNodeCount: readEvidenceNodeCount(run.resultJson),
    nodes: nodes.map((node) => {
      const codeDevelopment = codeDevelopmentByNodeId.get(node.id);
      return {
        id: node.id,
        runId: node.runId,
        agentId: node.agentId,
        title: node.title,
        instruction: node.instruction,
        dependsOnNodeIdsJson: node.dependsOnNodeIdsJson,
        status: node.status,
        taskQueueId: node.taskQueueId,
        resultJson: node.resultJson,
        errorText: node.errorText,
        sortOrder: node.sortOrder,
        queuedAt: node.queuedAt,
        startedAt: node.startedAt,
        finishedAt: node.finishedAt,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        codeDevelopmentSessionId: codeDevelopment?.sessionId,
        codeDevelopmentWorktreePath: codeDevelopment?.worktreePath,
        codeDevelopmentBranchName: codeDevelopment?.branchName,
      };
    }),
  };
}

function normalizeLimit(value: string | null): number {
  if (!value) {
    return DEFAULT_LIST_LIMIT;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function readPriority(value: unknown): CollaborationDispatchPriority | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCodeDevelopmentSessionsByNodeId(planJson: string): Map<
  string,
  { sessionId: string | undefined; worktreePath: string | undefined; branchName: string | undefined }
> {
  let plan: Record<string, unknown>;
  try {
    plan = readObject(JSON.parse(planJson) as unknown);
  } catch {
    return new Map();
  }
  const codeDevelopment = readObject(plan.codeDevelopment);
  const sessions = Array.isArray(codeDevelopment.sessions) ? codeDevelopment.sessions : [];
  const entries: Array<
    readonly [
      string,
      { sessionId: string | undefined; worktreePath: string | undefined; branchName: string | undefined },
    ]
  > = [];

  for (const item of sessions) {
    const session = readObject(item);
    const nodeId = readTrimmedString(session.nodeId);
    if (!nodeId) {
      continue;
    }
    entries.push([
      nodeId,
      {
        sessionId: readTrimmedString(session.sessionId),
        worktreePath: readTrimmedString(session.worktreePath),
        branchName: readTrimmedString(session.branchName),
      },
    ]);
  }

  return new Map(entries);
}

function readEvidenceSummary(resultJson: string | undefined): string | undefined {
  const summary = readEvidence(resultJson).summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

function readEvidenceSourceCount(resultJson: string | undefined): number | undefined {
  const evidence = readEvidence(resultJson);
  if (typeof evidence.sourceCount === "number") {
    return evidence.sourceCount;
  }
  return Array.isArray(evidence.sources) ? evidence.sources.length : undefined;
}

function readEvidenceNodeCount(resultJson: string | undefined): number | undefined {
  const evidence = readEvidence(resultJson);
  if (typeof evidence.nodeCount === "number") {
    return evidence.nodeCount;
  }
  return Array.isArray(evidence.nodes) ? evidence.nodes.length : undefined;
}

function readEvidence(resultJson: string | undefined): Record<string, unknown> {
  if (!resultJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    const result = readObject(parsed);
    return readObject(result.evidence);
  } catch {
    return {};
  }
}
