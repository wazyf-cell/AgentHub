import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRoomFromInput } from "./create-room.ts";
import { RoomStore } from "./store.ts";
import { createTask } from "./tasks.ts";
import { mergeTask, runTask } from "./task-runner.ts";
import type { AgentBackend } from "./types.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "agenthub-runner-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  const store = new RoomStore(join(root, "data"));
  const room = createRoomFromInput(store, {
    name: "运行器房间",
    workspacePath: repo,
    defaultBinding: { platformId: "fake", modelId: "fake-planner" },
  });
  return { root, repo, store, room, owner: room.members[0].id };
}

function writingBackend(options: { file?: string; cost?: number; text?: string } = {}): AgentBackend {
  return {
    id: "test-backend",
    async runTurn(request) {
      if (request.prompt.includes("你是审查者")) {
        return { text: "APPROVE\n改动符合验收标准。", status: "completed", costYuan: 0.1 };
      }
      if (request.cwd) {
        writeFileSync(join(request.cwd, options.file ?? "out.txt"), options.text ?? "hello\n");
      }
      return { text: "完成实现，DONE", status: "completed", costYuan: options.cost ?? 0.1, usage: { totalTokens: 100 } };
    },
  };
}

test("task runner commits, verifies and merges a worktree task", async () => {
  const { root, repo, store, room, owner } = setup();
  try {
    const task = createTask(store, room.id, {
      title: "写一个文件",
      description: "创建 out.txt",
      acceptance: "out.txt 存在",
      ownerMemberId: owner,
      verificationCommand: "node --version",
    });
    const result = await runTask({ store, roomId: room.id, taskId: task.id, backend: writingBackend() });
    assert.equal(result.task.status, "merge_ready");
    assert.ok(result.task.branch);
    assert.ok(result.report?.commit);
    assert.equal(result.report?.verification?.passed, true);
    assert.equal(existsSync(join(result.task.worktreePath!, "out.txt")), true);

    const merged = mergeTask(store, room.id, task.id);
    assert.equal(merged.status, "merged");
    assert.equal(readFileSync(join(repo, "out.txt"), "utf8").replace(/\r\n/g, "\n"), "hello\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task runner rejects files outside allowed paths and failed verification", async () => {
  const { root, store, room, owner } = setup();
  try {
    const violation = createTask(store, room.id, {
      title: "越界写入",
      description: "只允许 src",
      acceptance: "不应越界",
      ownerMemberId: owner,
      allowedPaths: ["src"],
    });
    const violationResult = await runTask({
      store, roomId: room.id, taskId: violation.id, backend: writingBackend({ file: "out.txt" }),
    });
    assert.equal(violationResult.task.status, "failed");
    assert.match(violationResult.error ?? "", /允许路径/);

    const badVerify = createTask(store, room.id, {
      title: "验证失败",
      description: "验证命令返回非零",
      acceptance: "应失败",
      ownerMemberId: owner,
      verificationCommand: "node -e \"process.exit(3)\"",
    });
    const badResult = await runTask({ store, roomId: room.id, taskId: badVerify.id, backend: writingBackend() });
    assert.equal(badResult.task.status, "failed");
    assert.equal(badResult.report?.verification?.passed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task runner pauses when the budget is exceeded", async () => {
  const { root, store, room, owner } = setup();
  try {
    const task = createTask(store, room.id, {
      title: "超预算",
      description: "花费超过预算",
      acceptance: "暂停",
      ownerMemberId: owner,
      budgetYuan: 0.5,
    });
    const result = await runTask({ store, roomId: room.id, taskId: task.id, backend: writingBackend({ cost: 3 }) });
    assert.equal(result.task.status, "budget_paused");
    assert.match(result.error ?? "", /预算/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review runs with an independent member, never the owner itself", async () => {
  const { root, repo, store, room, owner } = setup();
  try {
    room.members.push({
      id: "reviewer",
      name: "审查者",
      role: "审查",
      instructions: "审查改动并给出结论。",
      binding: { platformId: "fake", modelId: "fake-reviewer" },
      behavior: { weight: 1 },
    });
    store.writeRoom(room);
    const seen: string[] = [];
    const backend: AgentBackend = {
      id: "test-backend",
      async runTurn(request) {
        seen.push(request.member.id);
        if (request.prompt.includes("你是审查者")) {
          return { text: "APPROVE", status: "completed" };
        }
        if (request.cwd) writeFileSync(join(request.cwd, "out.txt"), "hello\n");
        return { text: "完成，DONE", status: "completed" };
      },
    };
    const task = createTask(store, room.id, {
      title: "独立审查",
      description: "创建 out.txt",
      acceptance: "out.txt 存在",
      ownerMemberId: owner,
    });
    const result = await runTask({ store, roomId: room.id, taskId: task.id, backend });
    assert.equal(result.task.status, "merge_ready");
    assert.ok(seen.includes(`${owner}__task_${task.id}`));
    assert.ok(seen.includes(`reviewer__review_${task.id}`));
    assert.equal(result.report?.review?.reviewerMemberId, "reviewer");
    assert.equal(result.report?.review?.verdict, "approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
