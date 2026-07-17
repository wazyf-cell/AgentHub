import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCountCollaborationRunsSync,
  mockCreateAndDispatchCollaborationRunSync,
  mockGetWorkspaceContextForIdentifier,
  mockListCollaborationRunsSync,
  mockListCollaborationTaskNodesSync,
} = vi.hoisted(() => ({
  mockCountCollaborationRunsSync: vi.fn(),
  mockCreateAndDispatchCollaborationRunSync: vi.fn(),
  mockGetWorkspaceContextForIdentifier: vi.fn(),
  mockListCollaborationRunsSync: vi.fn(),
  mockListCollaborationTaskNodesSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceContextForIdentifier: mockGetWorkspaceContextForIdentifier,
}));

vi.mock("@agent-space/db", () => ({
  countCollaborationRunsSync: mockCountCollaborationRunsSync,
  listCollaborationRunsSync: mockListCollaborationRunsSync,
  listCollaborationTaskNodesSync: mockListCollaborationTaskNodesSync,
}));

vi.mock("@agent-space/services", () => ({
  createAndDispatchCollaborationRunSync: mockCreateAndDispatchCollaborationRunSync,
}));

import { GET, POST } from "./route";

describe("workspace collaboration runs route", () => {
  beforeEach(() => {
    mockCountCollaborationRunsSync.mockReset();
    mockCreateAndDispatchCollaborationRunSync.mockReset();
    mockGetWorkspaceContextForIdentifier.mockReset();
    mockListCollaborationRunsSync.mockReset();
    mockListCollaborationTaskNodesSync.mockReset();
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext());
    mockCountCollaborationRunsSync.mockReturnValue(1);
  });

  it("lists collaboration runs with nodes for the current workspace", async () => {
    mockListCollaborationRunsSync.mockReturnValue([
      buildRun({
        id: "run-1",
        title: "Release plan",
        resultJson: JSON.stringify({
          evidence: {
            summary: "Run completed with two node summaries.",
            sourceCount: 3,
            nodeCount: 2,
          },
        }),
      }),
    ]);
    mockListCollaborationTaskNodesSync.mockReturnValue([
      buildNode({ id: "node-1", runId: "run-1", title: "Draft" }),
      buildNode({ id: "node-2", runId: "run-1", title: "Review" }),
    ]);

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockListCollaborationRunsSync).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 20 });
    expect(mockCountCollaborationRunsSync).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    expect(mockListCollaborationTaskNodesSync).toHaveBeenCalledWith("run-1", "workspace-1");
    expect(payload.totalCount).toBe(1);
    expect(payload.limit).toBe(20);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]).toMatchObject({
      id: "run-1",
      title: "Release plan",
      evidenceSummary: "Run completed with two node summaries.",
      evidenceSourceCount: 3,
      evidenceNodeCount: 2,
      nodes: [{ id: "node-1" }, { id: "node-2" }],
    });
    expect(payload.runs[0].planJson).toBeUndefined();
    expect(payload.runs[0].createdByUserId).toBeUndefined();
    expect(payload.runs[0].nodes[0].workspaceId).toBeUndefined();
  });

  it("clamps GET limit and pushes it into the DB query", async () => {
    mockListCollaborationRunsSync.mockReturnValue([]);
    mockCountCollaborationRunsSync.mockReturnValue(125);

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs?limit=500"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockListCollaborationRunsSync).toHaveBeenCalledWith({ workspaceId: "workspace-1", limit: 100 });
    expect(payload).toMatchObject({
      totalCount: 125,
      limit: 100,
      runs: [],
    });
  });

  it("creates and dispatches a deterministic collaboration DAG", async () => {
    const createdRun = buildRun({ id: "run-created", title: "Ship feature" });
    const firstNode = buildNode({ id: "plan", runId: "run-created", title: "Plan", taskQueueId: "queue-plan" });
    const secondNode = buildNode({ id: "review", runId: "run-created", title: "Review", status: "pending" });
    mockCreateAndDispatchCollaborationRunSync.mockReturnValue({
      run: createdRun,
      nodes: [firstNode, secondNode],
      dispatched: [{ node: firstNode, taskQueueId: "queue-plan" }],
      skipped: [],
    });
    mockListCollaborationTaskNodesSync.mockReturnValue([firstNode, secondNode]);

    const response = await POST(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs", {
        method: "POST",
        body: JSON.stringify({
          title: "Ship feature",
          goal: "Implement and review the feature",
          priority: "high",
          nodes: [
            { id: "plan", agentId: "Atlas", title: "Plan", instruction: "Draft a plan" },
            { id: "review", agentId: "Nova", title: "Review", instruction: "Review the plan", dependsOnNodeIds: ["plan"] },
          ],
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(mockCreateAndDispatchCollaborationRunSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      title: "Ship feature",
      goal: "Implement and review the feature",
      priority: "high",
      nodes: [
        { id: "plan", agentId: "Atlas", title: "Plan", instruction: "Draft a plan", dependsOnNodeIds: undefined },
        { id: "review", agentId: "Nova", title: "Review", instruction: "Review the plan", dependsOnNodeIds: ["plan"] },
      ],
      synthesis: undefined,
      createdByUserId: "user-1",
      createdByDisplayName: "Tianyu",
      requestedByUserId: "user-1",
      requestedByDisplayName: "Tianyu",
    });
    expect(payload).toMatchObject({
      run: {
        id: "run-created",
        nodes: [{ id: "plan" }, { id: "review" }],
      },
      dispatched: [{ nodeId: "plan", taskQueueId: "queue-plan" }],
      skipped: [],
    });
  });

  it("rejects invalid dependencies before calling the orchestrator", async () => {
    const response = await POST(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs", {
        method: "POST",
        body: JSON.stringify({
          title: "Bad DAG",
          goal: "Invalid dependency",
          nodes: [
            { id: "review", agentId: "Nova", title: "Review", instruction: "Review", dependsOnNodeIds: ["missing"] },
          ],
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'nodes[0] depends on unknown node "missing".' });
    expect(mockCreateAndDispatchCollaborationRunSync).not.toHaveBeenCalled();
  });

  it("requires admin role to create collaboration runs", async () => {
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext({ role: "member" }));

    const response = await POST(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs", {
        method: "POST",
        body: JSON.stringify({
          title: "Member DAG",
          goal: "A member should not be able to create orchestration runs yet.",
          nodes: [
            { id: "plan", agentId: "Atlas", title: "Plan", instruction: "Draft a plan" },
          ],
        }),
      }),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden." });
    expect(mockCreateAndDispatchCollaborationRunSync).not.toHaveBeenCalled();
  });

  it("rejects channel-scoped contexts", async () => {
    mockGetWorkspaceContextForIdentifier.mockResolvedValue(buildWorkspaceContext({ accessScope: "channel" }));

    const response = await GET(
      new Request("http://localhost/api/workspaces/workspace-alpha/collaboration-runs"),
      { params: Promise.resolve({ workspaceId: "workspace-alpha" }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden." });
  });
});

function buildWorkspaceContext(options: { accessScope?: "workspace" | "channel"; role?: "owner" | "admin" | "member" } = {}) {
  return {
    accessScope: options.accessScope ?? "workspace",
    currentUser: {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "Tianyu",
      role: "owner",
      email: "tianyu@example.com",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-alpha",
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: options.role ?? "owner",
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}

type TestCollaborationRun = ReturnType<typeof buildRunShape> & {
  resultJson?: string;
};

function buildRun(overrides: Partial<TestCollaborationRun> = {}): TestCollaborationRun {
  return {
    ...buildRunShape(),
    ...overrides,
  };
}

function buildRunShape() {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    title: "Collaboration run",
    goal: "Coordinate work",
    status: "running",
    planJson: "{}",
    createdByUserId: "user-1",
    createdByDisplayName: "Tianyu",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:01:00.000Z",
  };
}

type TestCollaborationNode = ReturnType<typeof buildNodeShape> & {
  taskQueueId?: string;
};

function buildNode(overrides: Partial<TestCollaborationNode> = {}): TestCollaborationNode {
  return {
    ...buildNodeShape(),
    ...overrides,
  };
}

function buildNodeShape() {
  return {
    id: "node-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    agentId: "Atlas",
    title: "Node",
    instruction: "Do work",
    dependsOnNodeIdsJson: "[]",
    status: "queued",
    sortOrder: 0,
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:01:00.000Z",
  };
}
