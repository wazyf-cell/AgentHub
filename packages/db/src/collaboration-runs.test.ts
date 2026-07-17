import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  approveCollaborationRunSync,
  bindEmployeeRuntimeSync,
  completeCollaborationTaskNodeSync,
  countCollaborationRunsSync,
  createCollaborationRunSync,
  createWorkspaceSync,
  failCollaborationTaskNodeSync,
  getDatabase,
  listCollaborationRunEventsSync,
  listCollaborationRunsSync,
  listCollaborationTaskNodesSync,
  listQueuedTasksSync,
  listReadyCollaborationTaskNodesSync,
  queueCollaborationTaskNodeSync,
  readCollaborationRunSync,
  readCollaborationTaskNodeSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
} from "./index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-collaboration-runs-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec("DELETE FROM collaboration_run_event");
  db.exec("DELETE FROM collaboration_task_node");
  db.exec("DELETE FROM collaboration_run");
  db.exec("DELETE FROM task_execution_event");
  db.exec("DELETE FROM task_message");
  db.exec("DELETE FROM token_usage");
  db.exec("DELETE FROM agent_router_event");
  db.exec("DELETE FROM agent_router_context_snapshot");
  db.exec("DELETE FROM agent_task_attempt");
  db.exec("DELETE FROM agent_router_provider_session");
  db.exec("DELETE FROM agent_task_queue");
  db.exec("DELETE FROM agent_router_session");
  db.exec("DELETE FROM employee_runtime_binding");
  db.exec("DELETE FROM agent_runtime");
  db.exec("DELETE FROM daemon_connection");
});

test("creates a collaboration DAG and advances ready nodes after dependencies complete", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-dag");
  const { run, nodes } = createCollaborationRunSync({
    workspaceId,
    title: "Plan Osaka trip",
    goal: "让多个 Agent 分工完善大阪行程。",
    createdByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-research",
        agentId: "Atlas",
        title: "Research Osaka",
        instruction: "收集大阪第一天行程素材。",
      },
      {
        id: "node-review",
        agentId: "Nova",
        title: "Review Osaka",
        instruction: "审查 Atlas 的行程草案。",
        dependsOnNodeIds: ["node-research"],
      },
      {
        id: "node-summary",
        agentId: "Atlas",
        title: "Summarize Osaka",
        instruction: "汇总最终行程。",
        dependsOnNodeIds: ["node-review"],
      },
    ],
  });

  assert.equal(run.status, "approved");
  assert.deepEqual(nodes.map((node) => [node.id, node.status]), [
    ["node-research", "ready"],
    ["node-review", "pending"],
    ["node-summary", "pending"],
  ]);
  assert.deepEqual(listReadyCollaborationTaskNodesSync(run.id, workspaceId).map((node) => node.id), ["node-research"]);

  const afterResearch = completeCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-research",
    result: { output: "大阪城和道顿堀适合第一天。" },
  });

  assert.equal(afterResearch.node.status, "completed");
  assert.equal(afterResearch.run.status, "running");
  assert.deepEqual(afterResearch.readyNodes.map((node) => node.id), ["node-review"]);

  completeCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-review",
    result: { output: "草案可用，但需要补交通时间。" },
  });
  const afterSummary = completeCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-summary",
    result: { output: "最终大阪行程完成。" },
  });

  assert.equal(afterSummary.run.status, "completed");
  assert.equal(readCollaborationRunSync(run.id, workspaceId)?.status, "completed");
  assert.deepEqual(
    listCollaborationRunEventsSync(run.id, workspaceId).map((event) => event.type),
    ["run.created", "node.completed", "node.completed", "node.completed"],
  );
});

test("queues a ready collaboration node into the native task queue with orchestration metadata", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-queue");
  const { run } = createCollaborationRunSync({
    workspaceId,
    title: "Prepare analysis",
    goal: "让 Atlas 先做资料分析。",
    nodes: [
      {
        id: "node-analysis",
        agentId: "Atlas",
        title: "Analyze input",
        instruction: "分析用户输入并产出要点。",
      },
    ],
  });

  const queued = queueCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-analysis",
    requestedByDisplayName: "Tianyu",
  });

  assert.ok(queued);
  assert.equal(queued.node.status, "queued");
  assert.equal(readCollaborationRunSync(run.id, workspaceId)?.status, "running");
  const task = readQueuedTaskSync(queued.taskQueueId);
  assert.ok(task);
  const payload = JSON.parse(task.inputJson) as {
    orchestrationRunId?: string;
    orchestrationStepId?: string;
    stepInstruction?: string;
  };
  assert.equal(payload.orchestrationRunId, run.id);
  assert.equal(payload.orchestrationStepId, "node-analysis");
  assert.equal(payload.stepInstruction, "分析用户输入并产出要点。");

  assert.throws(
    () => queueCollaborationTaskNodeSync({ workspaceId, nodeId: "node-analysis" }),
    /not ready/i,
  );
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 1);
});

test("does not reserve or orphan a queue task when a ready collaboration node lacks runtime binding", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-missing-binding");
  const { run } = createCollaborationRunSync({
    workspaceId,
    title: "Prepare unbound analysis",
    goal: "验证无 runtime binding 时不会留下 orphan queue。",
    nodes: [
      {
        id: "node-unbound",
        agentId: "Unbound",
        title: "Unbound analyze",
        instruction: "这个 agent 没有绑定 runtime。",
      },
    ],
  });

  const queued = queueCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-unbound",
    requestedByDisplayName: "Tianyu",
  });

  assert.equal(queued, null);
  assert.equal(readCollaborationRunSync(run.id, workspaceId)?.status, "approved");
  const node = readCollaborationTaskNodeSync("node-unbound", workspaceId);
  assert.equal(node?.status, "ready");
  assert.equal(node?.taskQueueId, undefined);
  assert.equal(node?.queuedAt, undefined);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 0);
  assert.deepEqual(
    listCollaborationRunEventsSync(run.id, workspaceId).map((event) => event.type),
    ["run.created"],
  );
});

test("keeps draft collaboration nodes pending until the run is approved", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-approval");
  const { run, nodes } = createCollaborationRunSync({
    workspaceId,
    title: "Draft implementation plan",
    goal: "先审阅计划，再派发多个 Agent。",
    status: "draft",
    createdByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-plan",
        agentId: "Atlas",
        title: "Plan",
        instruction: "输出实现计划。",
      },
      {
        id: "node-review",
        agentId: "Nova",
        title: "Review",
        instruction: "审查计划。",
        dependsOnNodeIds: ["node-plan"],
      },
    ],
  });

  assert.equal(run.status, "draft");
  assert.equal(run.approvedAt, undefined);
  assert.deepEqual(nodes.map((node) => [node.id, node.status]), [
    ["node-plan", "pending"],
    ["node-review", "pending"],
  ]);
  assert.deepEqual(listReadyCollaborationTaskNodesSync(run.id, workspaceId), []);

  const approved = approveCollaborationRunSync({
    workspaceId,
    runId: run.id,
    approvedByDisplayName: "Tianyu",
  });

  assert.equal(approved.run.status, "approved");
  assert.ok(approved.run.approvedAt);
  assert.deepEqual(approved.nodes.map((node) => [node.id, node.status]), [
    ["node-plan", "ready"],
    ["node-review", "pending"],
  ]);
  assert.deepEqual(approved.readyNodes.map((node) => node.id), ["node-plan"]);
  assert.deepEqual(
    listCollaborationRunEventsSync(run.id, workspaceId).map((event) => event.type),
    ["run.created", "run.approved"],
  );
  assert.throws(
    () => approveCollaborationRunSync({ workspaceId, runId: run.id }),
    /not a draft/i,
  );
});

test("failing a collaboration node blocks downstream dependents", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-fail");
  const { run } = createCollaborationRunSync({
    workspaceId,
    title: "Review chain",
    goal: "验证失败会阻断下游。",
    nodes: [
      {
        id: "node-a",
        agentId: "Atlas",
        title: "A",
        instruction: "先执行 A。",
      },
      {
        id: "node-b",
        agentId: "Nova",
        title: "B",
        instruction: "依赖 A。",
        dependsOnNodeIds: ["node-a"],
      },
      {
        id: "node-c",
        agentId: "Atlas",
        title: "C",
        instruction: "依赖 B。",
        dependsOnNodeIds: ["node-b"],
      },
    ],
  });

  completeCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-a",
    result: { output: "A done" },
  });
  const failed = failCollaborationTaskNodeSync({
    workspaceId,
    nodeId: "node-b",
    errorText: "B failed",
  });

  assert.equal(failed.run.status, "failed");
  assert.deepEqual(failed.blockedNodes.map((node) => node.id), ["node-c"]);
  assert.deepEqual(
    listCollaborationTaskNodesSync(run.id, workspaceId).map((node) => [node.id, node.status]),
    [
      ["node-a", "completed"],
      ["node-b", "failed"],
      ["node-c", "blocked"],
    ],
  );
});

test("rejects collaboration runs with missing or cyclic dependencies", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-invalid");

  assert.throws(
    () =>
      createCollaborationRunSync({
        workspaceId,
        title: "Invalid",
        goal: "missing dependency",
        nodes: [
          {
            id: "node-a",
            agentId: "Atlas",
            title: "A",
            instruction: "A",
            dependsOnNodeIds: ["node-missing"],
          },
        ],
      }),
    /unknown node/i,
  );

  assert.throws(
    () =>
      createCollaborationRunSync({
        workspaceId,
        title: "Cycle",
        goal: "cycle",
        nodes: [
          {
            id: "node-a",
            agentId: "Atlas",
            title: "A",
            instruction: "A",
            dependsOnNodeIds: ["node-b"],
          },
          {
            id: "node-b",
            agentId: "Nova",
            title: "B",
            instruction: "B",
            dependsOnNodeIds: ["node-a"],
          },
        ],
      }),
    /cycle/i,
  );
});

test("lists and counts collaboration runs with workspace, status, and limit filters", () => {
  const { workspaceId } = seedWorkspaceRuntime("collab-list");
  createCollaborationRunSync({
    id: "run-list-a",
    workspaceId,
    title: "List A",
    goal: "first run",
    status: "approved",
    nodes: [
      {
        id: "node-list-a",
        agentId: "Atlas",
        title: "A",
        instruction: "A",
      },
    ],
  });
  createCollaborationRunSync({
    id: "run-list-b",
    workspaceId,
    title: "List B",
    goal: "second run",
    status: "running",
    nodes: [
      {
        id: "node-list-b",
        agentId: "Atlas",
        title: "B",
        instruction: "B",
      },
    ],
  });

  assert.equal(countCollaborationRunsSync({ workspaceId }), 2);
  assert.equal(countCollaborationRunsSync({ workspaceId, status: "running" }), 1);
  assert.deepEqual(
    listCollaborationRunsSync({ workspaceId, limit: 1 }).map((run) => run.id),
    ["run-list-b"],
  );
  assert.deepEqual(
    listCollaborationRunsSync({ workspaceId, status: "approved" }).map((run) => run.id),
    ["run-list-a"],
  );
});

function seedWorkspaceRuntime(prefix: string): { workspaceId: string; runtimeId: string } {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const workspace = createWorkspaceSync({
    id: `${prefix}-${suffix}`,
    slug: `${prefix}-${suffix}`,
    name: `${prefix} ${suffix}`,
    createdBy: "test",
  });
  const runtime = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: `${workspace.id}-daemon`,
    deviceName: `${workspace.id} daemon`,
    runtimes: [{ provider: "codex", name: "Codex Runtime" }],
  }).runtimes[0];
  assert.ok(runtime?.id);
  bindEmployeeRuntimeSync({
    workspaceId: workspace.id,
    employeeName: "Atlas",
    runtimeId: runtime.id,
  });
  bindEmployeeRuntimeSync({
    workspaceId: workspace.id,
    employeeName: "Nova",
    runtimeId: runtime.id,
  });
  return { workspaceId: workspace.id, runtimeId: runtime.id };
}

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
