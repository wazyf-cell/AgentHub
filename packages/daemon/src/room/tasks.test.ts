import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoomFromInput } from "./create-room.ts";
import { RoomStore } from "./store.ts";
import {
  archiveTask,
  createTask,
  loadTasks,
  readTaskEvents,
  recordTaskReport,
  recoverRunningTasks,
  restoreTask,
  setTaskStatus,
  updateTask,
} from "./tasks.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-tasks-"));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  const store = new RoomStore(join(root, "data"));
  const room = createRoomFromInput(store, {
    name: "任务房间",
    workspacePath: workspace,
    defaultBinding: { platformId: "fake", modelId: "fake-planner" },
  });
  return { root, workspace, store, room, owner: room.members[0].id };
}

test("tasks validate dependencies and reject cycles", () => {
  const { root, store, room, owner } = setup();
  try {
    const first = createTask(store, room.id, {
      title: "第一步",
      description: "做第一件事",
      acceptance: "文件存在",
      ownerMemberId: owner,
    });
    assert.equal(first.status, "ready");

    const second = createTask(store, room.id, {
      title: "第二步",
      description: "依赖第一步",
      acceptance: "检查通过",
      ownerMemberId: owner,
      dependsOn: [first.id],
    });
    assert.equal(second.status, "backlog");
    assert.throws(() => setTaskStatus(store, room.id, second.id, "ready"), /dependencies/);

    assert.throws(() => updateTask(store, room.id, first.id, { dependsOn: [second.id] }), /cycle/);
    assert.throws(() => updateTask(store, room.id, first.id, { dependsOn: ["missing"] }), /does not exist/);

    setTaskStatus(store, room.id, first.id, "running");
    setTaskStatus(store, room.id, first.id, "review");
    setTaskStatus(store, room.id, first.id, "merge_ready");
    setTaskStatus(store, room.id, first.id, "done");
    assert.equal(setTaskStatus(store, room.id, second.id, "ready").status, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task status transitions and running locks follow the plan", () => {
  const { root, store, room, owner } = setup();
  try {
    const task = createTask(store, room.id, {
      title: "状态机",
      description: "验证迁移",
      acceptance: "状态正确",
      ownerMemberId: owner,
    });
    assert.throws(() => setTaskStatus(store, room.id, task.id, "done"), /cannot move/);
    setTaskStatus(store, room.id, task.id, "running");
    assert.throws(() => updateTask(store, room.id, task.id, { ownerMemberId: "other" }), /locked/);
    assert.throws(() => updateTask(store, room.id, task.id, { acceptance: "新" }), /locked/);
    setTaskStatus(store, room.id, task.id, "review");
    const report = recordTaskReport(store, room.id, task.id, {
      version: 1,
      taskId: task.id,
      summary: "完成",
      risks: [],
      nextSteps: [],
      files: ["a.txt"],
      diffstat: "1 file",
      generatedAt: new Date().toISOString(),
    });
    assert.equal(report.costYuan, undefined);
    setTaskStatus(store, room.id, task.id, "merge_ready");
    setTaskStatus(store, room.id, task.id, "done");
    assert.throws(() => setTaskStatus(store, room.id, task.id, "ready"), /cannot move/);
    const events = readTaskEvents(store, room.id, task.id);
    assert.ok(events.some((event) => event.type === "task_status"));
    assert.equal(loadTasks(store, room.id)[0].status, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running tasks are recovered as interrupted, never auto-resumed", () => {  const { root, store, room, owner } = setup();
  try {
    const task = createTask(store, room.id, {
      title: "崩溃恢复",
      description: "模拟退出",
      acceptance: "变成 interrupted",
      ownerMemberId: owner,
    });
    setTaskStatus(store, room.id, task.id, "running");
    assert.equal(recoverRunningTasks(store, room.id), 1);
    assert.equal(recoverRunningTasks(store, room.id), 0);
    assert.equal(loadTasks(store, room.id)[0].status, "interrupted");
    assert.equal(setTaskStatus(store, room.id, task.id, "ready").status, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tasks can be archived and restored without changing status", () => {
  const { root, store, room, owner } = setup();
  try {
    const task = createTask(store, room.id, {
      title: "归档任务",
      description: "做完后归档",
      acceptance: "可以从归档恢复",
      ownerMemberId: owner,
    });
    setTaskStatus(store, room.id, task.id, "running");
    assert.throws(() => archiveTask(store, room.id, task.id), /运行中/);
    setTaskStatus(store, room.id, task.id, "review");
    setTaskStatus(store, room.id, task.id, "merge_ready");
    setTaskStatus(store, room.id, task.id, "done");
    const archived = archiveTask(store, room.id, task.id);
    assert.ok(archived.archivedAt);
    assert.equal(archived.status, "done");
    assert.ok(readTaskEvents(store, room.id, task.id).some((event) => event.type === "task_archived"));
    const restored = restoreTask(store, room.id, task.id);
    assert.equal(restored.archivedAt, undefined);
    assert.equal(restored.status, "done");
    assert.ok(readTaskEvents(store, room.id, task.id).some((event) => event.type === "task_restored"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
