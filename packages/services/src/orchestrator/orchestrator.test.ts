import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  enqueueNativeTaskSync,
  getDatabase,
  listCollaborationRunEventsSync,
  listCollaborationTaskNodesSync,
  listQueuedTasksSync,
  listReadyCollaborationTaskNodesSync,
  readCollaborationRunSync,
  readQueuedTaskSync,
  registerDaemonRuntimesSync,
} from "@agent-space/db";
import {
  approveCollaborationPlanSync,
  completeCollaborationNodeAndDispatchNextSync,
  completeQueuedTaskAndAdvanceCollaborationSync,
  createAndDispatchCollaborationRunSync,
  createCollaborationPlanDraftSync,
  dispatchReadyCollaborationNodesSync,
  failQueuedTaskAndAdvanceCollaborationSync,
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

test("dispatches downstream and synthesis nodes after dependencies complete", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-synthesis", ["Atlas", "Nova", "Synth"]);
  const result = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Fan-in synthesis",
    goal: "两个 Agent 先并行执行，再由 Synth 汇总。",
    requestedByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-a",
        agentId: "Atlas",
        title: "A",
        instruction: "输出 A 结果。",
      },
      {
        id: "node-b",
        agentId: "Nova",
        title: "B",
        instruction: "输出 B 结果。",
      },
    ],
    synthesis: {
      id: "node-synthesis",
      agentId: "Synth",
      title: "Synthesize",
      instruction: "结合 A 和 B 的结果输出最终结论。",
    },
  });

  assert.deepEqual(result.dispatched.map((item) => item.node.id), ["node-a", "node-b"]);
  assert.deepEqual(
    listCollaborationTaskNodesSync(result.run.id, workspaceId).map((node) => [node.id, node.status, JSON.parse(node.dependsOnNodeIdsJson)]),
    [
      ["node-a", "queued", []],
      ["node-b", "queued", []],
      ["node-synthesis", "pending", ["node-a", "node-b"]],
    ],
  );
  assert.equal(JSON.parse(readCollaborationRunSync(result.run.id, workspaceId)!.planJson).synthesis.nodeId, "node-synthesis");

  const afterA = completeCollaborationNodeAndDispatchNextSync({
    workspaceId,
    nodeId: "node-a",
    result: { output: "A done" },
    requestedByDisplayName: "Tianyu",
  });
  assert.deepEqual(afterA.dispatched, []);
  assert.deepEqual(afterA.skipped, []);
  assert.deepEqual(listReadyCollaborationTaskNodesSync(result.run.id, workspaceId), []);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);

  const afterB = completeCollaborationNodeAndDispatchNextSync({
    workspaceId,
    nodeId: "node-b",
    result: { output: "B done" },
    requestedByDisplayName: "Tianyu",
  });
  assert.deepEqual(afterB.readyNodes.map((node) => node.id), ["node-synthesis"]);
  assert.deepEqual(afterB.dispatched.map((item) => item.node.id), ["node-synthesis"]);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 3);
  assert.equal(readCollaborationRunSync(result.run.id, workspaceId)?.status, "running");

  const final = completeCollaborationNodeAndDispatchNextSync({
    workspaceId,
    nodeId: "node-synthesis",
    result: { output: "Final answer" },
    requestedByDisplayName: "Tianyu",
  });
  assert.equal(final.run.status, "completed");
  assert.deepEqual(final.dispatched, []);
  assert.equal(JSON.parse(readCollaborationRunSync(result.run.id, workspaceId)!.resultJson!).output, "Final answer");
});

test("completion dispatch is idempotent and reports unbound downstream nodes as skipped", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("orchestrator-next", ["Atlas"]);
  const result = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Completion dispatch",
    goal: "完成上游后自动派发下游。",
    nodes: [
      {
        id: "node-root",
        agentId: "Atlas",
        title: "Root",
        instruction: "先完成 root。",
      },
      {
        id: "node-next",
        agentId: "Unbound",
        title: "Next",
        instruction: "未绑定 runtime 的下游。",
        dependsOnNodeIds: ["node-root"],
      },
    ],
  });

  assert.deepEqual(result.dispatched.map((item) => item.node.id), ["node-root"]);
  const afterRoot = completeCollaborationNodeAndDispatchNextSync({
    workspaceId,
    nodeId: "node-root",
    result: { output: "root done" },
  });

  assert.deepEqual(afterRoot.dispatched, []);
  assert.equal(afterRoot.skipped.length, 1);
  assert.equal(afterRoot.skipped[0]?.node.id, "node-next");
  assert.deepEqual(listReadyCollaborationTaskNodesSync(result.run.id, workspaceId).map((node) => node.id), ["node-next"]);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 1);

  const repeated = completeCollaborationNodeAndDispatchNextSync({
    workspaceId,
    nodeId: "node-root",
    result: { output: "should not overwrite" },
  });

  assert.deepEqual(repeated.dispatched, []);
  assert.deepEqual(repeated.skipped, []);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 1);
  const rootNode = listCollaborationTaskNodesSync(result.run.id, workspaceId).find((node) => node.id === "node-root");
  assert.equal(JSON.parse(rootNode!.resultJson!).output, "root done");

  bindEmployeeRuntimeSync({
    workspaceId,
    employeeName: "Unbound",
    runtimeId,
  });
  const redispatched = dispatchReadyCollaborationNodesSync({
    workspaceId,
    runId: result.run.id,
  });

  assert.deepEqual(redispatched.dispatched.map((item) => item.node.id), ["node-next"]);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);
});

test("native task completion advances the linked collaboration node and dispatches downstream", () => {
  const { workspaceId, runtimeId } = seedWorkspaceRuntime("orchestrator-native-complete", ["Atlas", "Nova"]);
  const run = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Native completion bridge",
    goal: "native task complete 后推进 collaboration DAG。",
    requestedByDisplayName: "Tianyu",
    nodes: [
      {
        id: "node-root",
        agentId: "Atlas",
        title: "Root",
        instruction: "完成 root。",
      },
      {
        id: "node-next",
        agentId: "Nova",
        title: "Next",
        instruction: "完成 next。",
        dependsOnNodeIds: ["node-root"],
      },
    ],
  });
  const rootTaskId = run.dispatched.find((item) => item.node.id === "node-root")!.taskQueueId;

  const advanced = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: rootTaskId,
    resultJson: {
      output: "root completed by runtime",
      attachments: [
        {
          id: "attachment-root",
          fileName: "root-summary.md",
        },
      ],
      documentUpdates: [
        {
          id: "doc-update-root",
          title: "Root plan",
        },
      ],
    },
    sessionId: "provider-session-root",
    workDir: "runtime-root",
    requestedByDisplayName: "Tianyu",
  });

  assert.equal(advanced.task.status, "completed");
  assert.ok(advanced.collaboration);
  assert.deepEqual(advanced.collaboration.dispatched.map((item) => item.node.id), ["node-next"]);
  const rootNode = listCollaborationTaskNodesSync(run.run.id, workspaceId).find((node) => node.id === "node-root");
  assert.equal(rootNode?.status, "completed");
  assert.equal(JSON.parse(rootNode!.resultJson!).output, "root completed by runtime");
  assert.equal(JSON.parse(rootNode!.resultJson!).sessionId, "provider-session-root");
  assert.deepEqual(JSON.parse(rootNode!.resultJson!).evidence, {
    version: 1,
    status: "completed",
    summary: "root completed by runtime",
    sourceCount: 2,
    sources: [
      {
        kind: "attachment",
        label: "root-summary.md",
        ref: "attachment-root",
      },
      {
        kind: "document_update",
        label: "Root plan",
        ref: "doc-update-root",
      },
    ],
    runtime: {
      taskQueueId: rootTaskId,
      runtimeId,
      sessionId: "provider-session-root",
      workDir: "runtime-root",
      finishedAt: advanced.task.finishedAt,
    },
  });
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);

  const repeated = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: rootTaskId,
    resultJson: { output: "should not dispatch twice" },
  });

  assert.equal(repeated.skippedReason, undefined);
  assert.ok(repeated.collaboration);
  assert.deepEqual(repeated.collaboration.dispatched, []);
  assert.equal(listQueuedTasksSync({ workspaceId }).length, 2);
  const unchangedRootNode = listCollaborationTaskNodesSync(run.run.id, workspaceId).find((node) => node.id === "node-root");
  assert.equal(JSON.parse(unchangedRootNode!.resultJson!).output, "root completed by runtime");
});

test("native task failure fails the linked collaboration node and blocks dependents", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-native-fail", ["Atlas", "Nova"]);
  const run = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Native failure bridge",
    goal: "native task fail 后阻断 collaboration DAG。",
    nodes: [
      {
        id: "node-root",
        agentId: "Atlas",
        title: "Root",
        instruction: "失败 root。",
      },
      {
        id: "node-next",
        agentId: "Nova",
        title: "Next",
        instruction: "依赖 root。",
        dependsOnNodeIds: ["node-root"],
      },
    ],
  });
  const rootTaskId = run.dispatched.find((item) => item.node.id === "node-root")!.taskQueueId;

  const failed = failQueuedTaskAndAdvanceCollaborationSync({
    taskId: rootTaskId,
    errorText: "runtime failed root",
    errorCode: "runtime.failed",
  });

  assert.equal(failed.task.status, "failed");
  assert.ok(failed.collaboration);
  assert.equal(failed.collaboration.run.status, "failed");
  assert.deepEqual(failed.collaboration.blockedNodes.map((node) => node.id), ["node-next"]);
  assert.deepEqual(
    listCollaborationTaskNodesSync(run.run.id, workspaceId).map((node) => [node.id, node.status]),
    [
      ["node-root", "failed"],
      ["node-next", "blocked"],
    ],
  );
  assert.equal(
    listCollaborationRunEventsSync(run.run.id, workspaceId).some((event) => event.type === "node.failed"),
    true,
  );

  const repeated = failQueuedTaskAndAdvanceCollaborationSync({
    taskId: rootTaskId,
    errorText: "should be ignored",
  });
  assert.equal(repeated.skippedReason, "collaboration_node_already_terminal");
  assert.equal(listCollaborationRunEventsSync(run.run.id, workspaceId).filter((event) => event.type === "node.failed").length, 1);
});

test("native task completion skips collaboration sync when the run is already terminal", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-native-terminal-run", ["Atlas", "Nova"]);
  const run = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Terminal run bridge",
    goal: "并行节点中一个失败后，另一个 native complete 不应让 bridge 抛错。",
    nodes: [
      {
        id: "node-a",
        agentId: "Atlas",
        title: "A",
        instruction: "失败 A。",
      },
      {
        id: "node-b",
        agentId: "Nova",
        title: "B",
        instruction: "完成 B。",
      },
    ],
  });
  const taskAId = run.dispatched.find((item) => item.node.id === "node-a")!.taskQueueId;
  const taskBId = run.dispatched.find((item) => item.node.id === "node-b")!.taskQueueId;

  failQueuedTaskAndAdvanceCollaborationSync({
    taskId: taskAId,
    errorText: "node A failed first",
  });
  const completedAfterTerminal = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: taskBId,
    resultJson: { output: "B finished after run failed" },
  });

  assert.equal(completedAfterTerminal.task.status, "completed");
  assert.equal(completedAfterTerminal.skippedReason, "collaboration_run_already_terminal");
  assert.equal(completedAfterTerminal.collaboration, undefined);
  assert.deepEqual(
    listCollaborationTaskNodesSync(run.run.id, workspaceId).map((node) => [node.id, node.status]),
    [
      ["node-a", "failed"],
      ["node-b", "queued"],
    ],
  );
  assert.equal(listCollaborationRunEventsSync(run.run.id, workspaceId).filter((event) => event.type === "node.completed").length, 0);
});

test("native task completion and failure no-op for non-collaboration tasks", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-native-noop", ["Atlas"]);
  const task = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Standalone native task",
    priority: "medium",
    triggerType: "manual",
    metadata: { source: "standalone" },
  });
  assert.ok(task);

  const completed = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: task.id,
    resultJson: { output: "standalone done" },
  });
  assert.equal(completed.task.status, "completed");
  assert.equal(completed.skippedReason, "not_collaboration_task");
  assert.equal(completed.collaboration, undefined);

  const failedTask = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Standalone failure task",
    priority: "medium",
    triggerType: "manual",
    metadata: { source: "standalone" },
  });
  assert.ok(failedTask);
  const failed = failQueuedTaskAndAdvanceCollaborationSync({
    taskId: failedTask.id,
    errorText: "standalone failed",
  });
  assert.equal(failed.task.status, "failed");
  assert.equal(failed.skippedReason, "not_collaboration_task");
  assert.equal(failed.collaboration, undefined);
});

test("native task completion no-ops for legacy orchestration metadata without a collaboration node", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-native-legacy-noop", ["Atlas"]);
  const task = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Legacy orchestration task",
    priority: "medium",
    triggerType: "manual",
    metadata: {
      orchestrationRunId: "legacy-run-id",
      orchestrationStepId: "legacy-step-id",
    },
  });
  assert.ok(task);

  const completed = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: task.id,
    resultJson: { output: "legacy done" },
  });

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.skippedReason, "not_collaboration_task");
  assert.equal(completed.collaboration, undefined);
});

test("native task completion no-ops when legacy orchestration metadata collides with an unrelated collaboration node", () => {
  const { workspaceId } = seedWorkspaceRuntime("orchestrator-native-legacy-collision", ["Atlas"]);
  const run = createAndDispatchCollaborationRunSync({
    workspaceId,
    title: "Legacy collision",
    goal: "旧 orchestrationStepId 撞上 collaboration node id 时不能错推 DAG。",
    nodes: [
      {
        id: "node-root",
        agentId: "Atlas",
        title: "Root",
        instruction: "真实 collaboration root。",
      },
    ],
  });
  const task = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Unrelated legacy task",
    priority: "medium",
    triggerType: "manual",
    metadata: {
      orchestrationRunId: run.run.id,
      orchestrationStepId: "node-root",
    },
  });
  assert.ok(task);

  const completed = completeQueuedTaskAndAdvanceCollaborationSync({
    taskId: task.id,
    resultJson: { output: "legacy collision done" },
  });

  assert.equal(completed.task.status, "completed");
  assert.equal(completed.skippedReason, "not_collaboration_task");
  assert.equal(completed.collaboration, undefined);
  const rootNode = listCollaborationTaskNodesSync(run.run.id, workspaceId).find((node) => node.id === "node-root");
  assert.equal(rootNode?.status, "queued");
  assert.equal(rootNode?.resultJson, undefined);
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
