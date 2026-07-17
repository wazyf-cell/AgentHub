import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  getDatabase,
  listCollaborationRunEventsSync,
  listCollaborationTaskNodesSync,
  listQueuedTasksSync,
  listReadyCollaborationTaskNodesSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
} from "@agent-space/db";
import {
  approveCollaborationPlanSync,
  createAndDispatchCollaborationRunSync,
  createCollaborationPlanDraftSync,
  dispatchReadyCollaborationNodesSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-orchestrator-service-"));

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
  db.exec("DELETE FROM workspace");
});

test("creates a reviewable draft plan and approves root nodes before dispatch", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-draft", ["Atlas", "Nova"]);
  const draft = createCollaborationPlanDraftSync({
    workspaceId,
    title: "Implement multi-agent planning",
    goal: "先审阅多 Agent 计划，再派发执行。",
    plan: { source: "manual" },
    createdByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-architecture",
        agentId: "Atlas",
        title: "Architecture",
        instruction: "设计编排服务入口。",
      },
      {
        id: "node-review",
        agentId: "Nova",
        title: "Review",
        instruction: "审查架构方案。",
        dependsOnNodeIds: ["node-architecture"],
      },
    ],
  });

  assert.equal(draft.run.status, "draft");
  assert.equal(draft.run.approvedAt, undefined);
  assert.equal(JSON.parse(draft.run.planJson).review.required, true);
  assert.deepEqual(draft.nodes.map((node) => [node.id, node.status]), [
    ["node-architecture", "pending"],
    ["node-review", "pending"],
  ]);
  assert.throws(
    () => dispatchReadyCollaborationNodesSync({ workspaceId, runId: draft.run.id }),
    /must be approved/i,
  );

  const approved = approveCollaborationPlanSync({
    workspaceId,
    runId: draft.run.id,
    approvedByDisplayName: "Tianyu",
  });

  assert.equal(approved.run.status, "approved");
  assert.deepEqual(approved.readyNodes.map((node) => node.id), ["node-architecture"]);
  assert.deepEqual(
    listCollaborationTaskNodesSync(draft.run.id, workspaceId).map((node) => [node.id, node.status]),
    [
      ["node-architecture", "ready"],
      ["node-review", "pending"],
    ],
  );
  const approvedEvent = listCollaborationRunEventsSync(draft.run.id, workspaceId).find((event) => event.type === "run.approved");
  assert.ok(approvedEvent);
  assert.deepEqual(JSON.parse(approvedEvent.dataJson).readyNodeIds, ["node-architecture"]);
});

test("creates, auto-approves, dispatches ready nodes, and keeps repeated dispatch idempotent", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-dispatch", ["Atlas", "Nova"]);
  const result = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Parallel implementation",
    goal: "让两个 Agent 并行处理独立任务。",
    createdByDisplayName: "Tianyu",
    requestedByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-db",
        agentId: "Atlas",
        title: "DB work",
        instruction: "实现 DB 契约。",
      },
      {
        id: "node-service",
        agentId: "Nova",
        title: "Service work",
        instruction: "实现服务层入口。",
      },
      {
        id: "node-final",
        agentId: "Atlas",
        title: "Final review",
        instruction: "汇总结果。",
        dependsOnNodeIds: ["node-db", "node-service"],
      },
    ],
  });

  assert.equal(result.run.status, "running");
  assert.deepEqual(result.dispatched.map((item) => item.node.id), ["node-db", "node-service"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(listReadyCollaborationTaskNodesSync(result.run.id, workspaceId), []);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);

  const firstTask = readQueuedTaskSync(result.dispatched[0]!.taskQueueId);
  assert.ok(firstTask);
  const payload = JSON.parse(firstTask.inputJson) as {
    collaborationRunId?: string;
    collaborationNodeId?: string;
    orchestrationRunId?: string;
    orchestrationStepId?: string;
    stepInstruction?: string;
    requester?: { displayName?: string };
  };
  assert.equal(payload.collaborationRunId, result.run.id);
  assert.equal(payload.orchestrationRunId, result.run.id);
  assert.equal(payload.collaborationNodeId, "node-db");
  assert.equal(payload.orchestrationStepId, "node-db");
  assert.equal(payload.stepInstruction, "实现 DB 契约。");
  assert.equal(payload.requester?.displayName, "Tianyu");

  const repeated = dispatchReadyCollaborationNodesSync({
    workspaceId,
    runId: result.run.id,
    requestedByDisplayName: "Tianyu",
  });

  assert.deepEqual(repeated.dispatched, []);
  assert.deepEqual(repeated.skipped, []);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);
});

test("reports ready nodes without runtime binding as skipped instead of successful dispatch", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-skipped", ["Atlas"]);
  const result = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Unbound agent work",
    goal: "验证未绑定 runtime 的 Agent 不会被误报为已派发。",
    nodes: [
      {
        id: "node-unbound",
        agentId: "Unbound",
        title: "Unbound work",
        instruction: "这个 Agent 没有 runtime binding。",
      },
    ],
  });

  assert.equal(result.run.status, "approved");
  assert.deepEqual(result.dispatched, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.node.id, "node-unbound");
  assert.equal(result.skipped[0]?.reason, "missing_runtime_binding");
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 0);
  assert.deepEqual(listReadyCollaborationTaskNodesSync(result.run.id, workspaceId).map((node) => node.id), ["node-unbound"]);
});

function seedWorkspaceRuntime(prefix: string, boundEmployeeNames: string[]): { workspaceId: string; runtimeId: string } {
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
  for (const employeeName of boundEmployeeNames) {
    bindEmployeeRuntimeSync({
      workspaceId: workspace.id,
      employeeName,
      runtimeId: runtime.id,
    });
  }
  return { workspaceId: workspace.id, runtimeId: runtime.id };
}

test.after(() => {
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
